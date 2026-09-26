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
  "block text-[10px] tracking-[0.14em] uppercase text-[var(--foreground-subtle)] mb-1.5";
const btnGhost =
  "px-4 py-2 text-[11px] tracking-[0.12em] uppercase border border-[var(--border)] text-[var(--foreground-muted)] hover:border-[var(--foreground)] hover:text-[var(--foreground)] transition-colors rounded-lg";
const cardCls = "rounded-xl border border-[var(--border)] bg-[var(--background)]";

const Spinner = () => (
  <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
);

type Phase = "idle" | "planning" | "collecting" | "done" | "stopped" | "halted";

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
  const [notice, setNotice] = useState("");

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

  const reply = useCallback((id: number | undefined, ok: boolean, data: unknown) => {
    if (typeof id !== "number") return;
    window.postMessage(
      { source: FROM_PAGE, id, ok, ...(ok ? { data } : { error: data }) },
      window.location.origin,
    );
  }, []);

  /** A one-way instruction to the worker (stop), with no reply expected. */
  const command = useCallback((type: string) => {
    window.postMessage({ source: FROM_PAGE, type }, window.location.origin);
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
            const data = await callApi({ action: "plan", ...payload });
            const urls = Array.isArray(data.urls) ? (data.urls as string[]) : [];
            setPlanned((n) => n + urls.length);
            setDelayMs(Number(data.delayMs) || 0);
            setRobots((data.robots as RobotsInfo) ?? null);
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
          setConnected(true);
          setPhase("collecting");
          try {
            const pageTitle = typeof payload.pageTitle === "string" ? payload.pageTitle : "";
            if (pageTitle && !titlesRef.current.includes(pageTitle)) {
              titlesRef.current = [...titlesRef.current, pageTitle].slice(-12);
            }
            const data = await callApi({
              action: "ingest",
              ...payload,
              titles: titlesRef.current,
            });
            const result = data.result as CrawlItemResult | undefined;
            if (result) setResults((prev) => [...prev, result]);
            reply(msg.id, true, data);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Ingest failed";
            const url = typeof payload.url === "string" ? payload.url : "";
            setResults((prev) => [...prev, { url, status: "failed", reason: message }]);
            reply(msg.id, false, message);
          }
          return;
        }

        case "progress": {
          setConnected(true);
          if (typeof payload.planned === "number") setPlanned(payload.planned);
          if (typeof payload.delayMs === "number") setDelayMs(payload.delayMs);
          if (typeof payload.store === "string" && payload.store) setStore(payload.store);
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
  }, [callApi, reply]);

  function stop() {
    stoppedRef.current = true;
    setPhase("stopped");
    command("stop");
  }

  function reset() {
    stoppedRef.current = false;
    titlesRef.current = [];
    setResults([]);
    setPlanned(0);
    setNotice("");
    setRobots(null);
    setPhase("idle");
  }

  const done = results.length;
  const imported = results.filter((r) => r.status === "imported").length;
  const updated = results.filter((r) => r.status === "updated").length;
  const failed = results.filter((r) => r.status === "failed" || r.status === "skipped").length;
  const photos = results.reduce((n, r) => n + (r.imagesMirrored ?? 0), 0);
  const running = phase === "planning" || phase === "collecting";
  const pct = planned ? Math.min(100, Math.round((done / planned) * 100)) : 0;

  return (
    <div className="max-w-[1440px] mx-auto px-6 md:px-12 py-8 space-y-5">
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
          <span className="text-[11px] text-[var(--foreground-muted)] truncate max-w-[420px]">
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
              Open the store you want, click the Goo icon, set how many products to collect and
              press <span className="text-[var(--foreground)]">Collect this store</span>.
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

      {/* Progress + outcomes */}
      {(running || results.length > 0) && (
        <div className={`${cardCls} overflow-hidden`}>
          <div className="px-5 py-3.5 border-b border-[var(--border)] space-y-2.5">
            <div className="flex items-center gap-4 flex-wrap">
              <p className="text-xs tracking-[0.12em] uppercase font-medium text-[var(--foreground)] inline-flex items-center gap-1.5">
                {running && <Spinner />}
                {phase === "planning" && "Reading the store…"}
                {phase === "collecting" && `Collecting ${done}/${planned || "…"}`}
                {phase === "done" && "Finished"}
                {phase === "stopped" && "Stopped"}
                {phase === "halted" && "Halted"}
                {phase === "idle" && "Ready"}
              </p>
              <div className="ml-auto flex items-center gap-3 text-[11px] tabular-nums">
                <span className="text-emerald-500">{imported} new</span>
                <span className="text-[var(--foreground-muted)]">{updated} updated</span>
                {failed > 0 && <span className="text-amber-500">{failed} skipped</span>}
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
            {photos > 0 && (
              <p className="text-[10px] text-[var(--foreground-subtle)]">
                {photos} photo{photos === 1 ? "" : "s"} copied to our storage
              </p>
            )}
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
                      className="text-[10px] text-[var(--foreground-muted)] truncate max-w-[220px] flex-shrink-0"
                      title={r.reason}
                    >
                      {r.reason}
                    </span>
                  )}
                  {!r.reason && detailLine(r) && (
                    <span
                      className="text-[10px] text-[var(--foreground-muted)] truncate max-w-[260px] flex-shrink-0"
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
                    className="text-[var(--foreground-subtle)] hover:text-[var(--foreground)] flex-shrink-0"
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
    const how = r.mergedBy === "name" ? " (same name and colour)" : "";
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
    imported: { label: "new", cls: "text-emerald-500 bg-emerald-500/10" },
    updated: { label: "upd", cls: "text-[var(--foreground-muted)] bg-[var(--fg-overlay-05)]" },
    skipped: { label: "skip", cls: "text-amber-500 bg-amber-500/10" },
    failed: { label: "fail", cls: "text-red-400 bg-red-500/10" },
  };
  const { label, cls } = map[status];
  return (
    <span
      className={`text-[9px] tracking-[0.1em] uppercase px-1.5 py-0.5 rounded flex-shrink-0 w-10 text-center ${cls}`}
    >
      {label}
    </span>
  );
}
