"use client";

/**
 * The screen the extension talks to.
 *
 * The extension has the reach and this tab has the session, so the work is
 * split exactly there. Chrome opens the store pages — the admin address, the
 * admin cookies, the anti-bot check their browser already passed — and hands
 * back rendered markup. This tab does the one thing an extension cannot: call
 * our admin API as the logged-in admin.
 *
 * Why not let the extension call the API itself? Our session is a Clerk cookie
 * that will not travel from a chrome-extension:// origin, and the alternative —
 * shipping a long-lived API token inside an extension anyone can unpack — is a
 * key under the doormat. Nothing secret is in the extension. It knows how to
 * ask this page, and this page is only useful to whoever is already signed in
 * as an admin in it.
 *
 * The wire is `window.postMessage`, which means the extension's content script
 * and this page share an origin. Every inbound message is checked for that
 * origin and for `event.source === window` before it is read: `postMessage` is
 * shoutable by any script on the page, and a bridge that skipped the check
 * would let one do our importing for us.
 *
 * Stop is enforced on both ends. The tab tells the worker to stop *and* starts
 * refusing ingest calls, so a worker that is mid-page when the button is
 * pressed cannot land one more product after it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CrawlItemResult } from "@/lib/server/parser/types";

// ── Wire protocol ────────────────────────────────────────────────────────────

/** Messages from the extension's content script to this page. */
const FROM_EXT = "goo-collect/ext";
/** Messages from this page back to the extension. */
const FROM_PAGE = "goo-collect/page";

interface ExtMessage {
  source: typeof FROM_EXT;
  /** Correlates a request with its reply; absent on one-way notices. */
  id?: number;
  type: "hello" | "plan" | "ingest" | "progress" | "done" | "error";
  payload?: Record<string, unknown>;
}

// ── goo-studio recipes (DESIGN_SYSTEM.md §9) ─────────────────────────────────

const labelCls =
  "block text-[10px] tracking-[0.14em] uppercase text-[var(--foreground-muted)] mb-1.5";
const btnGhost =
  "px-4 py-2 text-[11px] tracking-[0.12em] uppercase border border-[var(--border)] text-[var(--foreground-muted)] hover:border-[var(--foreground)] hover:text-[var(--foreground)] transition-colors rounded-lg";
const cardCls = "rounded-xl border border-[var(--border)] bg-[var(--background)]";

const Spinner = () => (
  <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
);

/**
 * `listing` is extension 1.0.14 walking the admin's own store tab to the end
 * of its grid before anything is planned; older extensions never send it.
 */
type Phase = "idle" | "listing" | "planning" | "collecting" | "done" | "stopped" | "halted";

/** How far the walk of the store's page has got: pages opened, links seen. */
interface ListingWalk {
  pages: number;
  links: number;
}

function isListingWalk(v: unknown): v is ListingWalk {
  return !!v && typeof v === "object" && typeof (v as ListingWalk).pages === "number" && typeof (v as ListingWalk).links === "number";
}

/** The two things a run can do with a store's pages. */
const MODES = [
  {
    label: "Make cards",
    linksOnly: false,
    says: "New pieces become products. A piece we already have gains this store as a place to buy.",
  },
  {
    label: "Links only",
    linksOnly: true,
    says: "Looks through this store for the pieces we already have and adds its link and price to them. Nothing new is created, and pages that are not ours are not opened.",
  },
] as const;

/**
 * Where the chosen mode is kept, so every collect tab runs in it: the extension
 * opens a collect tab of its own when it finds none, and a fresh tab used to
 * start in "Make cards" whatever the admin had chosen in another one.
 */
const MODE_KEY = "goo-collect-mode";

function saveMode(linksOnly: boolean) {
  try {
    window.localStorage.setItem(MODE_KEY, linksOnly ? "links" : "cards");
  } catch {
    /* storage blocked — the choice holds for this tab only */
  }
}

/**
 * The mode the extension asked for, when it asked. Its popup has a "Links
 * only" box of its own, and the box the admin ticked for this run beats the
 * mode this tab remembers. `linkOnly` is how extension 1.0.5 spelled it.
 */
function modeFromExtension(payload: Record<string, unknown>): boolean | undefined {
  if (typeof payload.linksOnly === "boolean") return payload.linksOnly;
  if (typeof payload.linkOnly === "boolean") return payload.linkOnly;
  return undefined;
}

/** What a links-only run's plan found among the store's pages. */
interface LinkSearch {
  cards: number;
  matched: number;
  unnamed: number;
  linked: number;
  other: number;
}

interface RobotsInfo {
  parsed: boolean;
  crawlDelayMs: number | null;
  blocked: number;
  sitemaps: string[];
}

export default function CollectPage() {
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [store, setStore] = useState("");
  const [results, setResults] = useState<CrawlItemResult[]>([]);
  const [planned, setPlanned] = useState(0);
  const [delayMs, setDelayMs] = useState(0);
  const [robots, setRobots] = useState<RobotsInfo | null>(null);
  const [linkSearch, setLinkSearch] = useState<LinkSearch | null>(null);
  const [notice, setNotice] = useState("");
  /** Pieces the store's page showed, as the planner counted them (1.0.14). */
  const [found, setFound] = useState(0);
  /** A run that asked for a few stopped reading the page early. */
  const [foundAtLeast, setFoundAtLeast] = useState(false);
  const [walk, setWalk] = useState<ListingWalk | null>(null);
  /** What the extension says about the walk: keep the tab in front, why it stopped. */
  const [walkNote, setWalkNote] = useState("");
  /**
   * Whether this run makes cards or only adds this store to the cards we have.
   * Chosen here, or in the extension's popup when it sends a choice with the
   * run (`modeFromExtension`) — this tab makes every plan and import call, so
   * the choice travels with them either way. Mirrored in a ref for the same
   * reason as Stop below, and kept in the browser (`MODE_KEY`) so a tab the
   * extension opens runs in it too.
   */
  const [linksOnly, setLinksOnly] = useState(false);
  const linksOnlyRef = useRef(false);

  // Before the bridge's listener below, so a tab the extension has just opened
  // knows its mode by the time the first plan arrives. Another collect tab
  // changing it changes it here too: the worker may be talking to either.
  useEffect(() => {
    const apply = (value: string | null) => {
      const on = value === "links";
      linksOnlyRef.current = on;
      setLinksOnly(on);
    };
    try {
      apply(window.localStorage.getItem(MODE_KEY));
    } catch {
      /* storage blocked — the mode starts at "Make cards" and lives in this tab */
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === MODE_KEY) apply(event.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  /**
   * Stop as a ref, not state: the message handler is registered once and would
   * otherwise close over the value it had when it was registered — which is
   * exactly the moment before the admin presses the button.
   */
  const stoppedRef = useRef(false);
  /**
   * Page titles seen in this run, sent back with each product so the server can
   * work out what this store appends to every title. Kept here because this is
   * the only place that sees more than one of the store's pages; what the
   * suffix *means* is still decided server-side.
   */
  const titlesRef = useRef<string[]>([]);
  /**
   * Imports under way, by page address. A page asked for again while its import
   * is running gets that import's answer instead of a second one: two bridges
   * in one tab (Goo Collect up to 1.0.18 could inject a second into a tab still
   * loading) passed every request twice, and the two imports of each page raced
   * to one address — a card and a "duplicate key" row for every piece.
   */
  const ingestsRef = useRef(new Map<string, Promise<{ ok: boolean; data: unknown }>>());

  const reply = useCallback((id: number | undefined, ok: boolean, data: unknown) => {
    if (typeof id !== "number") return;
    window.postMessage(
      { source: FROM_PAGE, id, ok, ...(ok ? { data } : { error: data }) },
      window.location.origin,
    );
  }, []);

  /** A one-way instruction to the worker (stop, retry), with no reply expected. */
  const command = useCallback((type: string) => {
    window.postMessage({ source: FROM_PAGE, type }, window.location.origin);
  }, []);

  /**
   * Forget the previous run: its Stop, its counters and the store's titles.
   *
   * Called by Clear and by every `hello` — the worker sends one at the start of
   * each run, so a Stop pressed on the last run cannot refuse the next one. Not
   * on `plan`: that arrives on every round of the same run.
   */
  const reset = useCallback(() => {
    stoppedRef.current = false;
    titlesRef.current = [];
    setResults([]);
    setPlanned(0);
    setDelayMs(0);
    setStore("");
    setNotice("");
    setRobots(null);
    setLinkSearch(null);
    setFound(0);
    setFoundAtLeast(false);
    setWalk(null);
    setWalkNote("");
    setPhase("idle");
  }, []);

  const callApi = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/admin/parser/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error ?? `Request failed (${res.status})`);
    }
    return data as Record<string, unknown>;
  }, []);

  useEffect(() => {
    async function onMessage(event: MessageEvent) {
      // Only this page, in this tab, on this origin. `postMessage` is open to
      // anything running here, and the bridge is a privileged one.
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;

      const msg = event.data as ExtMessage | null;
      if (!msg || msg.source !== FROM_EXT || typeof msg.type !== "string") return;

      const payload = msg.payload ?? {};

      switch (msg.type) {
        case "hello": {
          reset();
          setConnected(true);
          reply(msg.id, true, { ready: true });
          return;
        }

        case "plan": {
          if (stoppedRef.current) return reply(msg.id, false, "Stopped by the admin");
          setConnected(true);
          setPhase("planning");
          setNotice("");
          const target = typeof payload.url === "string" ? payload.url : "";
          setStore(target);
          try {
            const asked = modeFromExtension(payload);
            if (asked !== undefined && asked !== linksOnlyRef.current) {
              linksOnlyRef.current = asked;
              setLinksOnly(asked);
              saveMode(asked);
            }
            const data = await callApi({ action: "plan", ...payload, linksOnly: linksOnlyRef.current });
            const urls = Array.isArray(data.urls) ? (data.urls as string[]) : [];
            setPlanned((n) => n + urls.length);
            setDelayMs(Number(data.delayMs) || 0);
            setRobots((data.robots as RobotsInfo) ?? null);
            setLinkSearch((data.links as LinkSearch) ?? null);
            if (typeof data.linksNote === "string") setNotice(`Links only: ${data.linksNote}.`);
            if (urls.length) setPhase("collecting");
            reply(msg.id, true, data);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Plan failed";
            setNotice(message);
            setPhase("idle");
            reply(msg.id, false, message);
          }
          return;
        }

        case "ingest": {
          // Refusing here is what makes Stop immediate: a worker already
          // mid-page cannot land one more product after the button.
          if (stoppedRef.current) return reply(msg.id, false, "Stopped by the admin");
          const url = typeof payload.url === "string" ? payload.url : "";
          const running = url ? ingestsRef.current.get(url) : undefined;
          if (running) {
            const outcome = await running;
            return reply(msg.id, outcome.ok, outcome.data);
          }
          setConnected(true);
          setPhase("collecting");
          const job = (async () => {
            try {
              const pageTitle = typeof payload.pageTitle === "string" ? payload.pageTitle : "";
              if (pageTitle && !titlesRef.current.includes(pageTitle)) {
                titlesRef.current = [...titlesRef.current, pageTitle].slice(-12);
              }
              const data = await callApi({
                action: "ingest",
                ...payload,
                titles: titlesRef.current,
                linksOnly: modeFromExtension(payload) ?? linksOnlyRef.current,
              });
              const result = data.result as CrawlItemResult | undefined;
              if (result) setResults((prev) => [...prev, result]);
              return { ok: true, data: data as unknown };
            } catch (err) {
              const message = err instanceof Error ? err.message : "Ingest failed";
              setResults((prev) => [...prev, { url, status: "failed", reason: message }]);
              return { ok: false, data: message as unknown };
            }
          })();
          if (url) ingestsRef.current.set(url, job);
          const outcome = await job;
          if (url) ingestsRef.current.delete(url);
          reply(msg.id, outcome.ok, outcome.data);
          return;
        }

        case "progress": {
          setConnected(true);
          // A page the extension could not read never reaches an import, so it
          // is reported here, to stand in the rows with its reason.
          const failure = payload.failure as { url?: unknown; reason?: unknown } | undefined;
          if (failure && typeof failure.url === "string") {
            const reason = typeof failure.reason === "string" ? failure.reason : "failed";
            setResults((prev) => [...prev, { url: failure.url as string, status: "failed", reason }]);
            return;
          }
          if (typeof payload.planned === "number") setPlanned(payload.planned);
          if (typeof payload.delayMs === "number") setDelayMs(payload.delayMs);
          if (typeof payload.store === "string" && payload.store) setStore(payload.store);
          if (payload.phase === "listing") setPhase("listing");
          if (typeof payload.found === "number") setFound(payload.found);
          if (typeof payload.foundAtLeast === "boolean") setFoundAtLeast(payload.foundAtLeast);
          if (isListingWalk(payload.listing)) setWalk(payload.listing);
          if (typeof payload.message === "string") setWalkNote(payload.message);
          return;
        }

        case "error": {
          // The worker stopping itself — two refusals in a row, most often.
          setNotice(typeof payload.message === "string" ? payload.message : "The run stopped");
          setPhase("halted");
          return;
        }

        case "done": {
          setPhase((p) => (p === "stopped" ? "stopped" : "done"));
          return;
        }
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [callApi, reply, reset]);

  function chooseMode(value: boolean) {
    linksOnlyRef.current = value;
    setLinksOnly(value);
    saveMode(value);
  }

  function stop() {
    stoppedRef.current = true;
    setPhase("stopped");
    command("stop");
  }

  const done = results.length;
  const imported = results.filter((r) => r.status === "imported").length;
  const updated = results.filter((r) => r.status === "updated").length;
  const failed = results.filter((r) => r.status === "failed" || r.status === "skipped").length;
  /** Pages that went wrong, as opposed to pages that were not pieces: Retry is for these. */
  const retryable = results.filter((r) => r.status === "failed").length;
  const photos = results.reduce((n, r) => n + (r.imagesMirrored ?? 0), 0);
  // Saved without columns the database lacks — the same note on every row, so said once.
  const warnings = [...new Set(results.flatMap((r) => (r.warning ? [r.warning] : [])))];
  const running = phase === "listing" || phase === "planning" || phase === "collecting";
  const pct = planned ? Math.min(100, Math.round((done / planned) * 100)) : 0;

  return (
    <div className="max-w-5xl space-y-5">
      <header>
        <h1 className="font-display text-2xl font-light text-[var(--foreground)]">
          Collect with the browser extension
        </h1>
        <p className="text-xs text-[var(--foreground-muted)] mt-1">
          Keep this tab open. The extension opens store pages on your machine and this tab imports
          what they contain, signed in as you.
        </p>
      </header>

      {/* Connection */}
      <div className={`${cardCls} px-5 py-4 flex items-center gap-3 flex-wrap`}>
        <span
          aria-hidden="true"
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            connected ? "bg-emerald-500" : "bg-[var(--foreground-subtle)]"
          }`}
        />
        <p className="text-[11px] tracking-[0.12em] uppercase text-[var(--foreground)]">
          {connected ? "Extension connected" : "Waiting for the extension"}
        </p>
        {store && (
          <span className="text-[11px] text-[var(--foreground-muted)] truncate max-w-full md:max-w-[420px]">
            {store.replace(/^https?:\/\/(www\.)?/, "")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <button onClick={stop} className={btnGhost} aria-label="Stop the run">
              Stop
            </button>
          ) : (
            results.length > 0 && (
              <button onClick={reset} className={btnGhost}>
                Clear
              </button>
            )
          )}
        </div>
      </div>

      {/* What the run does with each page — set before starting it */}
      <div className={`${cardCls} px-5 py-4 flex items-center gap-4 flex-wrap`}>
        <div
          role="group"
          aria-label="What this run does"
          className="flex gap-0 bg-[var(--surface)] rounded-full p-1 border border-[var(--border)] w-fit"
        >
          {MODES.map((m) => {
            const active = linksOnly === m.linksOnly;
            return (
              <button
                key={m.label}
                type="button"
                aria-pressed={active}
                disabled={running}
                onClick={() => chooseMode(m.linksOnly)}
                className={`shrink-0 px-5 py-2 text-[10px] tracking-[0.16em] uppercase font-medium rounded-full transition-colors duration-200 disabled:opacity-40 ${
                  active
                    ? "bg-[var(--foreground)] text-[var(--background)]"
                    : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-[var(--foreground-muted)] flex-1 min-w-[220px]">
          {MODES.find((m) => m.linksOnly === linksOnly)?.says}
          {running && " Change it between runs."}
        </p>
      </div>

      {!connected && (
        <div className={`${cardCls} px-5 py-4 space-y-2`}>
          <p className={labelCls}>Install it once</p>
          <ol className="text-[12px] text-[var(--foreground-muted)] space-y-1 list-decimal pl-4">
            <li>
              Open <span className="text-[var(--foreground)]">chrome://extensions</span> and turn on
              Developer mode.
            </li>
            <li>
              Choose <span className="text-[var(--foreground)]">Load unpacked</span> and pick the{" "}
              <span className="text-[var(--foreground)]">extension/</span> folder from the
              repository.
            </li>
            <li>
              Open the store page you want (a category, a brand, a search), click the Goo icon
              and press <span className="text-[var(--foreground)]">Collect this page</span>. Keep
              that tab in front while it scrolls to the end; the pieces then open in the
              background.
            </li>
            <li>Chrome will ask once for permission to read that store. Grant it.</li>
          </ol>
        </div>
      )}

      {notice && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/15 px-5 py-3 text-[12px] text-amber-500">
          {notice}
        </div>
      )}

      {robots && (
        <div className={`${cardCls} px-5 py-3 flex items-center gap-4 flex-wrap text-[11px]`}>
          <span className={labelCls + " mb-0"}>robots.txt</span>
          <span className="text-[var(--foreground-muted)]">
            {robots.parsed ? "read" : "none published"}
          </span>
          <span className="text-[var(--foreground-muted)]">
            crawl-delay{" "}
            <span className="text-[var(--foreground)] tabular-nums">
              {robots.crawlDelayMs ? `${(robots.crawlDelayMs / 1000).toFixed(1)}s` : "not set"}
            </span>
          </span>
          <span className="text-[var(--foreground-muted)]">
            pacing at{" "}
            <span className="text-[var(--foreground)] tabular-nums">
              {(delayMs / 1000).toFixed(1)}s
            </span>
          </span>
          {robots.blocked > 0 && (
            <span className="text-amber-500 tabular-nums">{robots.blocked} disallowed, skipped</span>
          )}
        </div>
      )}

      {linkSearch && (
        <div className={`${cardCls} px-5 py-3 flex items-center gap-4 flex-wrap text-[11px]`}>
          <span className={labelCls + " mb-0"}>Looking for ours</span>
          <span className="text-[var(--foreground-muted)]">
            <span className="text-[var(--foreground)] tabular-nums">{linkSearch.matched}</span> store
            pages name one of our {linkSearch.cards} cards
          </span>
          {linkSearch.unnamed > 0 && (
            <span className="text-[var(--foreground-muted)]">
              <span className="tabular-nums">{linkSearch.unnamed}</span> name nothing by their
              address, opened after
            </span>
          )}
          {linkSearch.linked > 0 && (
            <span className="text-[var(--foreground-muted)]">
              <span className="tabular-nums">{linkSearch.linked}</span> already on a card
            </span>
          )}
          {linkSearch.other > 0 && (
            <span className="text-[var(--foreground-subtle)]">
              <span className="tabular-nums">{linkSearch.other}</span> not ours, not opened
            </span>
          )}
        </div>
      )}

      {/* Progress + outcomes */}
      {(running || results.length > 0) && (
        <div className={`${cardCls} overflow-hidden`}>
          <div className="px-5 py-3.5 border-b border-[var(--border)] space-y-2.5">
            <div className="flex items-center gap-4 flex-wrap">
              <p className="text-xs tracking-[0.12em] uppercase font-medium text-[var(--foreground)] inline-flex items-center gap-1.5">
                {running && <Spinner />}
                {phase === "listing" &&
                  `Scrolling the store page${walk && walk.pages > 1 ? `, page ${walk.pages}` : ""}… ${walk?.links ?? 0} links`}
                {phase === "planning" && "Reading the store…"}
                {phase === "collecting" && `Collecting ${done}/${planned || "…"}`}
                {phase === "done" && "Finished"}
                {phase === "stopped" && "Stopped"}
                {phase === "halted" && "Halted"}
                {phase === "idle" && "Ready"}
              </p>
              <div className="ml-auto flex flex-wrap items-center gap-3 text-[11px] tabular-nums">
                <span className="text-emerald-500">{imported} new</span>
                <span className="text-[var(--foreground-muted)]">{updated} updated</span>
                {failed > 0 && <span className="text-amber-500">{failed} skipped</span>}
                {!running && retryable > 0 && connected && (
                  <button
                    type="button"
                    onClick={() => command("retry")}
                    className="underline hover:no-underline text-amber-500"
                  >
                    Retry {retryable} failed
                  </button>
                )}
                {!running && results.length > 0 && (
                  <a
                    href="/goo-studio/products"
                    className="underline hover:no-underline text-[var(--foreground)]"
                  >
                    View products →
                  </a>
                )}
              </div>
            </div>
            <div className="h-1 rounded-full bg-[var(--fg-overlay-08)] overflow-hidden">
              <div
                className="h-full bg-[var(--foreground)] transition-[width] duration-300"
                style={{ width: `${phase === "planning" ? 4 : pct}%` }}
              />
            </div>
            {found > 0 && (
              <p className="text-[11px] text-[var(--foreground)] tabular-nums">
                Found {foundAtLeast ? "at least " : ""}
                {found} piece{found === 1 ? "" : "s"} on the page
                {planned > 0 && planned < found ? ` · collecting the first ${planned}` : ""}
              </p>
            )}
            {walkNote && (
              <p
                className={`text-[11px] ${
                  phase === "listing" ? "text-amber-500" : "text-[var(--foreground-muted)]"
                }`}
              >
                {walkNote}
              </p>
            )}
            {photos > 0 && (
              <p className="text-[10px] text-[var(--foreground-subtle)]">
                {photos} photo{photos === 1 ? "" : "s"} copied to our storage
              </p>
            )}
            {warnings.map((w) => (
              <p key={w} className="rounded-lg border border-amber-400/30 bg-amber-400/15 px-4 py-3 text-[12px] text-amber-500">
                {w}
              </p>
            ))}
          </div>

          {results.length > 0 && (
            <div className="max-h-[420px] overflow-y-auto divide-y divide-[var(--border)]">
              {results.map((r, i) => (
                <div
                  key={`${r.url}-${i}`}
                  className="px-5 py-2.5 flex items-center gap-3 text-[11px]"
                >
                  <StatusPill status={r.status} />
                  <span className="text-[var(--foreground)] truncate flex-1 min-w-0">
                    {r.name || r.url.replace(/^https?:\/\/(www\.)?/, "")}
                  </span>
                  {r.reason && (
                    <span
                      className="text-[10px] text-[var(--foreground-muted)] truncate max-w-[40%] md:max-w-[480px] flex-shrink-0"
                      title={r.reason}
                    >
                      {r.reason}
                    </span>
                  )}
                  {!r.reason && detailLine(r) && (
                    <span
                      className="text-[10px] text-[var(--foreground-muted)] truncate max-w-[40%] md:max-w-[480px] flex-shrink-0"
                      title={detailLine(r)}
                    >
                      {detailLine(r)}
                    </span>
                  )}
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open this page in a new tab"
                    className="inline-flex items-center justify-center min-w-10 min-h-10 md:min-w-0 md:min-h-0 text-[var(--foreground-subtle)] hover:text-[var(--foreground)] flex-shrink-0"
                  >
                    ↗
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!running && results.length === 0 && connected && (
        <p className="px-4 py-12 text-center text-sm text-[var(--foreground-subtle)]">
          Nothing collected yet. Start a run from the extension on a store page.
        </p>
      )}
    </div>
  );
}

/**
 * What a finished page has to say for itself beyond "imported".
 *
 * Two questions the admin would otherwise have to open the catalogue to answer:
 * how many photos came across, and what happened to the price. The second one
 * matters most on a store that does not price in dollars — the catalogue stores
 * dollars, so the row says which rate turned ₴4,000 into a number, rather than
 * leaving the admin to wonder whether it did. A brand read off the product name
 * is said too, since it replaced whatever the page gave.
 */
function detailLine(r: CrawlItemResult): string {
  const parts: string[] = [];
  if (r.images) parts.push(`${r.images} photo${r.images === 1 ? "" : "s"}`);
  if (r.priceNote) parts.push(r.priceNote);
  if (r.brandNote) parts.push(r.brandNote);
  if (r.colorNote) parts.push(r.colorNote);
  if (r.linkNote) parts.push(r.linkNote);
  if (r.genderNote) parts.push(r.genderNote);
  if (r.styleNote) parts.push(r.styleNote);
  if (r.variantsLinked) {
    parts.push(`grouped with ${r.variantsLinked} colour${r.variantsLinked === 1 ? "" : "s"}`);
  }
  // A merge is the interesting outcome on this row: the page did not create a
  // product, it added a place to buy one we already had.
  if (r.merged) {
    const filled = (r.mergedFields ?? []).filter((f) => f !== "retailer");
    // Said, because a name match is a judgement where a code match is a fact,
    // and the admin is the one who can undo a wrong one.
    const how = r.mergedBy === "name" ? " (same piece by name and colour)" : "";
    parts.push(
      filled.length
        ? `added as a store to an existing product${how}, filling ${filled.join(", ")}`
        : `added as a store to an existing product${how}`,
    );
  }
  return parts.join(" · ");
}

function StatusPill({ status }: { status: CrawlItemResult["status"] }) {
  const map: Record<CrawlItemResult["status"], { label: string; cls: string }> = {
    imported: { label: "new", cls: "text-emerald-500 bg-emerald-400/15 border-emerald-400/30" },
    updated: { label: "upd", cls: "text-[var(--foreground-muted)] bg-[var(--fg-overlay-05)] border-[var(--border)]" },
    skipped: { label: "skip", cls: "text-amber-500 bg-amber-400/15 border-amber-400/30" },
    failed: { label: "fail", cls: "text-red-500 bg-red-400/15 border-red-400/30" },
  };
  const { label, cls } = map[status];
  return (
    <span
      className={`text-[9px] tracking-[0.1em] uppercase px-1.5 py-0.5 rounded-full border flex-shrink-0 w-10 text-center ${cls}`}
    >
      {label}
    </span>
  );
}
