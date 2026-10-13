/**
 * The hands of the operation.
 *
 * Everything that has to happen from the admin's own address happens here:
 * reading robots.txt, pulling sitemaps down, opening each product page in a
 * real tab, waiting for it to render, taking the DOM and closing the tab again.
 * What to open, and how fast, is not decided here — the collect tab asks the
 * server and passes the answer back. This worker is deliberately without
 * judgement about what a product is.
 *
 * ## Why this is paced the way it is
 *
 * The cost of being rude has moved. A crawler on a Vercel function that gets
 * itself blocked costs an address nobody will miss. This runs on the admin's
 * home connection, under the address they also shop and bank from, and a block
 * earned here is earned on every store at once and cannot be rotated away.
 *
 * So four rules, and none of them is an optimisation to be tuned away:
 *
 *   - robots.txt is obeyed. The server applies it; nothing here can override it.
 *   - Between pages, the store's own Crawl-delay, never faster than 1.5s, plus
 *     a random spread so the pattern does not read as clockwork.
 *   - A ten-second rest every twenty pages, because a steady rate held for an
 *     hour is what a rate limiter is built to notice.
 *   - Two refusals in a row and the run stops and says so. One refusal can be a
 *     bad page; two in a row is the store telling us to go away, and carrying on
 *     past that is how an address ends up on a list.
 *
 * Stop is immediate. It wakes every pending pause rather than waiting one out,
 * and the collect tab independently refuses to import anything after it — so a
 * page already in flight cannot land after the button.
 */

import { sitemapPieces, takePieces, queuedBytes, PLAN_SITEMAP_BUDGET, PLAN_SITEMAP_DOCS } from "./sitemap-pieces.js";
import { listingStep, robotsRules, robotsAllows, planHtml } from "./listing.js";
import {
  menuStep,
  categoryCandidates,
  sitemapChildren,
  isSitemapIndex,
  localePrefix,
  SeenStore,
  PLAN_LINKS,
  SWEEP_ENTRIES,
} from "./site.js";

// ── Politeness constants ─────────────────────────────────────────────────────

/** Never faster than this, whatever robots.txt does or does not ask for. */
const MIN_DELAY_MS = 1_500;
/** Random spread added on top of the pause, as a fraction of it. */
const JITTER = 0.4;
/** Pages between rests. */
const REST_EVERY = 20;
/** How long a rest lasts. */
const REST_MS = 10_000;
/** Consecutive refusals that end the run. */
const REFUSAL_LIMIT = 2;
/**
 * Statuses counted as the store refusing us.
 *
 * 403 and 429 only, deliberately. A 500 or a 404 is a broken page and the run
 * should step over it; these two are the store saying no, and the difference
 * matters because only one of them is a reason to stop.
 */
const REFUSAL_STATUSES = new Set([403, 429]);

/** How long a bot check is given to pass on its own before it counts as a refusal. */
const CHECK_WAIT_MS = 6_000;

/**
 * How long a page may take before it is skipped. Up to 1.0.15 this was 45 s
 * spent waiting for the tab's "complete", which a good page with one tracker
 * that never answers does not reach: each such piece cost 45 s and was then
 * counted as failed, and a few in a row looked like the run had stopped.
 */
const PAGE_TIMEOUT_MS = 15_000;
/**
 * From when a page whose own markup is in may be read while something on it
 * is still loading. The store's answer has arrived and the document is built;
 * what is outstanding is a tracker, a chat widget, an ad.
 */
const READY_AFTER_MS = 4_000;
/** How long snapshot.js may take to read a page before the page is skipped. */
const READ_TIMEOUT_MS = 25_000;
/**
 * How long one import on the site may take. The site's own limit is 60 s
 * (Vercel ends the function); past this the collect tab is not answering at
 * all, and the piece is skipped rather than waited for.
 */
const INGEST_TIMEOUT_MS = 90_000;
/** Let a loaded page settle before reading it. */
const SETTLE_MS = 500;
/**
 * Planning rounds before we call a store done. A round is one plan call, and a
 * large store's sitemap now takes several of them (sitemap-pieces.js). They
 * cost the store nothing: a plan call goes only to our site.
 */
const MAX_ROUNDS = 24;
/** Pause between sitemap fetches — cheap requests, but still requests. */
const SITEMAP_GAP_MS = 400;

// ── Run state ────────────────────────────────────────────────────────────────

const state = {
  running: false,
  stopped: false,
  store: "",
  linksOnly: false,
  /** idle → listing (walking the admin's page) → planning → collecting → done / stopped / halted */
  phase: "idle",
  message: "",
  /** Pieces the page showed, as the planner counted them. */
  found: 0,
  /** True when a run that asked for a few stopped reading the page early. */
  foundAtLeast: false,
  /** While the page is walked: pages opened and links seen so far. */
  listing: null,
  /**
   * A whole-store run's place in the store: which stage (the menu, the
   * categories, the sitemaps), which category of how many, how many
   * sitemaps read. Null for every other kind of run.
   */
  site: null,
  planned: 0,
  done: 0,
  counts: { new: 0, updated: 0, skipped: 0, failed: 0 },
  /** Pages that failed, with why, for Retry. Not sent to the popup on every poll. */
  failures: [],
  delayMs: MIN_DELAY_MS,
  studioTabId: null,
};

function publicState() {
  const { failures, ...rest } = state;
  return { ...rest, failureCount: failures.length };
}

// ── Staying awake ────────────────────────────────────────────────────────────

/**
 * Chrome ends an extension's worker that has called no extension API for 30
 * seconds, and a run's state goes with it. A run calls one every few seconds
 * as it opens pages, but not while the site takes its time over an import or
 * a plan, and a whole-store run goes on for days. So while any run is going,
 * the worker asks Chrome something trivial every twenty seconds.
 */
let awake = null;

function stayAwake() {
  if (awake) return;
  awake = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20_000);
}

function letSleep() {
  clearInterval(awake);
  awake = null;
}

// ── Abortable waiting ────────────────────────────────────────────────────────

/** Pending sleeps, so Stop can cut every one of them short at once. */
const sleepers = new Set();

function sleep(ms) {
  return new Promise((resolve) => {
    const entry = {};
    entry.resolve = () => {
      clearTimeout(entry.timer);
      sleepers.delete(entry);
      resolve();
    };
    entry.timer = setTimeout(entry.resolve, ms);
    sleepers.add(entry);
  });
}

function wakeAll() {
  for (const entry of [...sleepers]) entry.resolve();
}

/** The store's pace plus a spread, so the rhythm is not machine-flat. */
function politePause() {
  const base = Math.max(state.delayMs, MIN_DELAY_MS);
  return sleep(base + Math.random() * base * JITTER);
}

// ── Talking to the collect tab ───────────────────────────────────────────────

async function rememberStudioTab(tabId) {
  state.studioTabId = tabId ?? null;
  try {
    await chrome.storage.session.set({ studioTabId: state.studioTabId });
  } catch {
    /* session storage is a convenience, not a requirement */
  }
}

async function studioTab() {
  if (state.studioTabId != null) return state.studioTabId;
  try {
    const { studioTabId } = await chrome.storage.session.get("studioTabId");
    if (typeof studioTabId === "number") state.studioTabId = studioTabId;
  } catch {
    /* ignore */
  }
  return state.studioTabId;
}

const NO_TAB =
  "The collect tab is not reachable. Open Goo Studio → Parser → Collect, reload that tab, and try again.";

const SIGNED_OUT =
  "The collect tab left the collect page — usually a sign-in redirect. Sign in to Goo Studio as an admin, open Parser → Collect, and try again.";

/** Where the collect screen lives; the bridge is only injected there. */
const COLLECT_URLS = [
  "http://localhost/goo-studio/parser/collect*",
  "http://127.0.0.1/goo-studio/parser/collect*",
  "https://goo-fashion.com/goo-studio/parser/collect*",
  "https://www.goo-fashion.com/goo-studio/parser/collect*",
];

/** Does this tab have a live bridge in it? */
async function answers(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { target: "bridge", type: "ping" });
    return !!res?.ok;
  } catch {
    return false;
  }
}

/**
 * Find a collect tab that can be talked to, mending one that cannot.
 *
 * The worker only learns the collect tab when a bridge announces itself, and
 * that link breaks quietly: the tab reloads, a sign-in redirect carries it off
 * the collect page, or the extension is updated — which leaves every open tab
 * with a bridge that belongs to the old copy and can no longer reach us. Each
 * of those used to end a run with "not reachable" while the tab sat right
 * there. So the known tab is tried, then every collect tab, and one whose
 * bridge is dead gets a fresh one.
 */
async function reconnect() {
  const known = await studioTab();
  if (known != null && (await answers(known))) return known;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: COLLECT_URLS });
  } catch {
    tabs = [];
  }
  if (known != null && !tabs.some((t) => t.id === known)) {
    // The tab we knew is no longer on the collect page: most often Clerk sent
    // it to sign in. Said as such, because reloading will not help.
    try {
      const tab = await chrome.tabs.get(known);
      if (tab && !tabs.length) {
        await rememberStudioTab(null);
        return { error: SIGNED_OUT };
      }
    } catch {
      /* closed */
    }
  }

  for (const tab of tabs) {
    if (await answers(tab.id)) {
      await rememberStudioTab(tab.id);
      return tab.id;
    }
  }
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] });
    } catch {
      continue;
    }
    if (await answers(tab.id)) {
      await rememberStudioTab(tab.id);
      return tab.id;
    }
  }
  await rememberStudioTab(null);
  return { error: NO_TAB };
}

/**
 * Ask the collect tab to call the API, and wait for what it got back.
 *
 * The second attempt goes through `reconnect`, which only hands back a tab
 * whose bridge has just answered. So a send that fails after that is not about
 * reaching the tab: the tab is there, and Chrome refused this one message. Up
 * to 1.0.12 that was reported as "not reachable" too, which sent the admin off
 * reloading a tab that was fine.
 */
async function askPage(type, payload) {
  let refused = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const tabId = attempt === 0 ? await studioTab() : await reconnect();
    if (tabId != null && typeof tabId === "object") return { ok: false, error: tabId.error };
    if (tabId == null) continue;
    try {
      const res = await chrome.tabs.sendMessage(tabId, { target: "bridge", type, payload });
      return res ?? { ok: false, error: "The collect tab did not answer" };
    } catch (err) {
      /* dead bridge or gone tab: reconnect and try once more */
      if (attempt === 1) refused = err?.message || "no reason given";
    }
  }
  if (refused) {
    return {
      ok: false,
      error: `The collect tab is open, but Chrome would not pass it the ${type} request (${refused}). Reloading the tab will not help: this is a fault in Goo Collect, not in the tab.`,
    };
  }
  return { ok: false, error: NO_TAB };
}

/** Tell the collect tab something. Failures here never stop a run. */
async function tellPage(type, payload) {
  const tabId = await studioTab();
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { target: "bridge", type, payload });
  } catch {
    /* the screen is a display, not a dependency */
  }
}

function pushProgress() {
  void tellPage("progress", {
    planned: state.planned,
    delayMs: state.delayMs,
    store: state.store,
    phase: state.phase,
    // A whole-store run's count would be one batch of one category, said as
    // "found on the page"; where the run is goes in the message instead.
    found: state.site ? 0 : state.found,
    foundAtLeast: state.foundAtLeast,
    listing: state.listing,
    message: state.message || siteLine(),
    site: state.site,
  });
}

/** Where a whole-store run is, in one line, for the collect tab. */
function siteLine() {
  const s = state.site;
  if (!s) return "";
  const sofar = `${state.done} piece${state.done === 1 ? "" : "s"} so far`;
  if (s.stage === "menu") return "Whole store: reading the store's menu…";
  if (s.stage === "categories") return `Whole store: category ${s.index + 1} of ${s.categories}, ${s.label}. ${sofar}.`;
  if (s.stage === "sitemaps") {
    return `Whole store: the sitemaps, for the pieces no category showed (${s.sitemapsRead} read). ${sofar}.`;
  }
  return `Whole store: ${sofar}.`;
}

// ── Reading what does not need a tab ─────────────────────────────────────────

/**
 * robots.txt and sitemaps, fetched from the worker.
 *
 * These are public documents meant for machines, and they do not need a
 * rendered page — so they cost a tab nothing. Cookies are sent because the
 * whole premise is that this looks like the admin's browser rather than a
 * stranger; a store that varies robots.txt by session should see the session
 * it is actually answering.
 */
async function fetchText(url) {
  try {
    const res = await fetch(url, { credentials: "include", redirect: "follow" });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Gzip announces itself in its first two bytes, whatever the URL ends with —
    // and a large catalogue's sitemap is routinely shipped compressed.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"));
      return await new Response(stream).text();
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// ── Reading a page that does need a tab ──────────────────────────────────────

/**
 * Status codes for the pages we open.
 *
 * `chrome.tabs` will not tell us whether a navigation was a 200 or a 403 — the
 * tab simply shows whatever came back. Observing the main-frame response is the
 * only way to know we are being refused, and knowing that is what the two-in-a-
 * row rule is built on. Observation only: nothing here blocks or rewrites a
 * request.
 */
const mainFrameStatus = new Map();

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.type === "main_frame" && details.tabId >= 0) {
      mainFrameStatus.set(details.tabId, details.statusCode);
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
);

/**
 * Pages that failed outright: no answer, a dropped connection, a name that
 * does not resolve. Chrome says so at once, and the piece is skipped at once,
 * instead of after the page timeout.
 */
const mainFrameError = new Map();

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.type === "main_frame" && details.tabId >= 0) {
      mainFrameError.set(details.tabId, details.error);
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
);

/**
 * `promise`, or `fallback` once `ms` have passed. Waits through `sleep`, so
 * Stop cuts it short too.
 */
async function withTimeout(promise, ms, fallback) {
  let done = false;
  const guarded = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (err) => {
      done = true;
      throw err;
    },
  );
  const timer = sleep(ms).then(() => (done ? undefined : fallback));
  const winner = await Promise.race([guarded, timer]);
  return done ? guarded : winner;
}

/** The document's readyState in a tab, or "" when it cannot be asked. */
async function readyState(tabId) {
  try {
    const out = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, func: () => document.readyState }),
      2_000,
      [],
    );
    return out?.[0]?.result ?? "";
  } catch {
    return "";
  }
}

/**
 * Wait until a freshly opened page can be read, and no longer than that.
 *
 * Ready means the tab reached "complete", or — from READY_AFTER_MS on — that
 * the store's answer is in and the document past "loading", whatever is still
 * fetching around it. A page that failed outright is reported as soon as
 * Chrome knows. A page with no answer after PAGE_TIMEOUT_MS is given up.
 */
async function waitForPage(tabId) {
  const started = Date.now();
  let complete = false;
  const onUpdated = (id, info) => {
    if (id === tabId && info.status === "complete") complete = true;
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    for (;;) {
      if (state.stopped) return { ok: false, error: "Stopped" };
      const failed = mainFrameError.get(tabId);
      // ERR_ABORTED is a navigation replaced by another (a script redirect),
      // not a failure: the next one is waited for.
      if (failed && failed !== "net::ERR_ABORTED") {
        return { ok: false, error: `The page did not load (${failed})` };
      }
      if (!complete) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) return { ok: false, error: "The tab was closed" };
        if (tab.status === "complete") complete = true;
      }
      if (complete) return { ok: true };

      const elapsed = Date.now() - started;
      const answered = mainFrameStatus.has(tabId);
      if (answered && elapsed >= READY_AFTER_MS) {
        const ready = await readyState(tabId);
        if (ready === "interactive" || ready === "complete") return { ok: true, early: true };
      }
      if (elapsed >= PAGE_TIMEOUT_MS) {
        return {
          ok: false,
          error: answered
            ? `The page was still loading after ${PAGE_TIMEOUT_MS / 1000} s`
            : `The store did not answer in ${PAGE_TIMEOUT_MS / 1000} s`,
        };
      }
      await sleep(250);
    }
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(value);
    };

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => finish(false), PAGE_TIMEOUT_MS);

    // The tab can reach "complete" before the listener is attached.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === "complete") finish(true);
      })
      .catch(() => finish(false));
  });
}

/**
 * Open one page, let it render, take the DOM, close the tab.
 *
 * The tab is created in the background so a run does not take the admin's
 * screen away from them, and it is always removed — a run that leaves tabs
 * behind is one nobody will start twice.
 */
async function snapshotPage(url) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    return { error: err?.message ?? "Could not open a tab" };
  }

  const tabId = tab.id;
  mainFrameStatus.delete(tabId);
  mainFrameError.delete(tabId);

  try {
    const page = await waitForPage(tabId);
    const status = mainFrameStatus.get(tabId) ?? 0;

    if (REFUSAL_STATUSES.has(status)) return { refused: true, status };
    if (status >= 400) return { error: `HTTP ${status}`, status };
    if (!page.ok) return { error: page.error };

    await sleep(SETTLE_MS);
    if (state.stopped) return { error: "Stopped" };

    // A page whose scripts lock it up would hold the read, and the run with
    // it, for as long as it liked. Closing the tab ends the read below.
    const read = async () => {
      const [injected] = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId }, files: ["snapshot.js"] }),
        READ_TIMEOUT_MS,
        [{ result: { ok: false, error: `The page did not let itself be read in ${READ_TIMEOUT_MS / 1000} s` } }],
      );
      return injected?.result;
    };
    let result = await read();
    // A bot check in the page's place. Some pass on their own in a few seconds
    // (Cloudflare's "Just a moment…" reloads into the page), so it is given
    // that long; one that is still there is the store refusing us, counted as
    // a 403 would be, and never sent as a product.
    if (result && result.ok && result.botCheck) {
      await sleep(CHECK_WAIT_MS);
      if (state.stopped) return { error: "Stopped" };
      await waitForPage(tabId);
      await sleep(SETTLE_MS);
      result = await read();
      if (result && result.ok && result.botCheck) {
        return { refused: true, status, check: String(result.botCheck).slice(0, 80) };
      }
    }
    if (!result || !result.ok) {
      return { error: result?.error ?? "Could not read the page" };
    }
    // `images` and `priceText` are what the page said before the strip removed
    // it — see the header of snapshot.js. They travel as candidates; the server
    // decides which of them belong to the product.
    return {
      html: result.html,
      images: Array.isArray(result.images) ? result.images : [],
      priceText: typeof result.priceText === "string" ? result.priceText : "",
      sizes: Array.isArray(result.sizes) ? result.sizes : [],
      colorText: typeof result.colorText === "string" ? result.colorText : "",
      colorCandidates: Array.isArray(result.colorCandidates) ? result.colorCandidates : [],
      titleText: typeof result.titleText === "string" ? result.titleText : "",
      shopify: result.shopify && typeof result.shopify === "object" ? result.shopify : null,
      variantUrls: Array.isArray(result.variantUrls) ? result.variantUrls : [],
      descriptionText: typeof result.descriptionText === "string" ? result.descriptionText : "",
      specs: Array.isArray(result.specs) ? result.specs : [],
      breadcrumbs: Array.isArray(result.breadcrumbs) ? result.breadcrumbs : [],
      brandText: typeof result.brandText === "string" ? result.brandText : "",
      pageTitle: typeof result.pageTitle === "string" ? result.pageTitle : "",
      // Where the tab ended up: a sold-out piece redirected to its category is
      // not that piece, and the site checks.
      finalUrl: typeof result.url === "string" ? result.url : "",
      status,
    };
  } catch (err) {
    return { error: err?.message ?? "Could not read the page" };
  } finally {
    mainFrameStatus.delete(tabId);
    mainFrameError.delete(tabId);
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* already gone */
    }
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

/** "Products to collect" when the admin asks for everything on the page. */
const MAX_LIMIT = 2_000;
/** How long the walk of one listing may take, all its pages together. */
const LISTING_MS = 10 * 60_000;
/** Pages of one listing the walk opens. */
const LISTING_PAGES = 100;
/** Links one walk keeps: past any category, a bound on what is sent, not a target. */
const LISTING_LINKS = 15_000;
/** Structured data kept from the walked pages, in characters. */
const LISTING_LD = 500_000;
/** How long the walk waits for the store tab to come back to the front. */
const HIDDEN_MS = 5 * 60_000;
/** Failed pages one run remembers, for Retry. */
const MAX_FAILURES = 500;
/** And one whole-store run, which opens a thousand times as many. */
const SITE_FAILURES = 5_000;
/**
 * Pieces a page must show at first sight to be a listing even though its
 * markup calls it one product. A product page shows a few related pieces at
 * most before it is scrolled; a category shows a grid.
 */
const GRID_MIN = 8;

const KEEP_IN_FRONT =
  "Bring the store tab back to the front. A store only loads more of its page while you can see it.";
const NOTHING_FOUND =
  "No pieces were found on this page. Open a page with a grid of products (a category, a brand, a search) and try again.";

/** Where every kind of run starts from. */
function begin(storeUrl, linksOnly, phase) {
  stayAwake();
  Object.assign(state, {
    running: true,
    stopped: false,
    store: storeUrl,
    linksOnly,
    phase,
    message: "",
    planned: 0,
    done: 0,
    found: 0,
    foundAtLeast: false,
    listing: null,
    site: null,
    counts: { new: 0, updated: 0, skipped: 0, failed: 0 },
    failures: [],
    delayMs: MIN_DELAY_MS,
  });
}

function failureCap() {
  return state.site ? SITE_FAILURES : MAX_FAILURES;
}

/** What a run came to, kept after the worker is gone so the popup can say it. */
function summary() {
  return {
    store: state.store,
    at: Date.now(),
    phase: state.phase,
    message: state.message,
    found: state.found,
    foundAtLeast: state.foundAtLeast,
    planned: state.planned,
    done: state.done,
    counts: { ...state.counts },
    failures: state.failures.slice(0, failureCap()),
    linksOnly: state.linksOnly,
    site: state.site,
  };
}

async function saveLastRun() {
  try {
    await chrome.storage.local.set({ lastRun: summary() });
  } catch {
    /* the summary is a convenience; the collect tab has every row */
  }
}

async function lastRun() {
  try {
    const { lastRun: last } = await chrome.storage.local.get("lastRun");
    return last && typeof last === "object" ? last : null;
  } catch {
    return null;
  }
}

/** One page's outcome, in the counts the admin is shown at the end. */
function record(url, status, reason) {
  const key = status === "imported" ? "new" : status;
  if (key in state.counts) state.counts[key]++;
  if (status === "failed" && state.failures.length < failureCap()) {
    state.failures.push({ url, reason: String(reason || "failed").slice(0, 300) });
  }
}

/**
 * A page that failed before the collect tab saw it: refused, or not read at
 * all. The tab lists what its imports return, so without this a page that
 * never loaded was missing from its rows, and "found 36, 35 new" had no
 * reason beside it. Sent as progress, which every bridge passes on without
 * waiting for an answer.
 */
function failedUnseen(url, reason) {
  record(url, "failed", reason);
  void tellPage("progress", { failure: { url, reason: String(reason || "failed").slice(0, 300) } });
}

function halt(message) {
  letSleep();
  if (currentSite) {
    message = `${message} ${RESUME_HINT}`;
    Object.assign(currentSite, { done: state.done, counts: { ...state.counts }, status: "halted" });
    void saveSiteRun(currentSite);
    currentSite = null;
  }
  state.running = false;
  state.phase = "halted";
  state.message = message;
  void tellPage("error", { message });
  void saveLastRun();
}

function finish() {
  letSleep();
  state.running = false;
  state.phase = state.stopped ? "stopped" : "done";
  void tellPage("done", {});
  void saveLastRun();
}

/** Hand one read page to the collect tab and record what the site made of it. */
async function ingest(url, snap, ctx) {
  const ingested = await withTimeout(
    askPage("ingest", {
      url,
      html: snap.html,
      // Sent in links-only runs too: the site keeps no photo from them, but
      // may read the colour off one, and the colour picks the right card.
      images: snap.images,
      linksOnly: ctx.linksOnly,
      priceText: snap.priceText,
      sizes: snap.sizes,
      colorText: snap.colorText,
      colorCandidates: snap.colorCandidates,
      titleText: snap.titleText,
      shopify: snap.shopify,
      variantUrls: snap.variantUrls,
      descriptionText: snap.descriptionText,
      specs: snap.specs,
      breadcrumbs: snap.breadcrumbs,
      brandText: snap.brandText,
      pageTitle: snap.pageTitle,
      finalUrl: snap.finalUrl,
    }),
    INGEST_TIMEOUT_MS,
    { ok: false, error: `The site did not finish importing it in ${INGEST_TIMEOUT_MS / 1000} s` },
  );
  state.done++;
  if (ingested.ok) {
    const result = ingested.data?.result;
    record(url, result?.status || "imported", result?.reason);
  } else if (!state.stopped) {
    record(url, "failed", ingested.error);
  }
  pushProgress();
}

/**
 * Open each address in turn, at the store's pace, and hand what it shows to
 * the collect tab. Every kind of run ends here. Returns false when the store
 * made the run stop: two refusals in a row.
 *
 * A page that fails is recorded with its reason and skipped; only the store
 * refusing us twice in a row stops the run. Imports run one at a time and in
 * page order, so the site matching a piece against the catalogue has seen the
 * piece before it, but the store is not kept waiting for them: the next page
 * is opened while the last one is being imported.
 *
 * A whole-store run hands `ctx.mark`, which writes each address down as soon
 * as its fate is known (read, refused, failed), so no category, sitemap or
 * Resume after it opens that page again.
 */
async function collect(urls, ctx) {
  /** The import still running on the site, if any. */
  let importing = null;
  const settle = async () => {
    if (importing) {
      await importing;
      importing = null;
    }
  };

  try {
    for (const url of urls) {
      if (state.stopped || ctx.collected >= ctx.limit) break;
      if (ctx.seen) ctx.seen.push(url);

      await politePause();
      if (state.stopped) break;

      const snap = await snapshotPage(url);
      // Stopped while the page was open: not a failure, and nothing to retry.
      if (state.stopped) break;

      if (ctx.mark) await ctx.mark(url);

      if (snap.refused) {
        ctx.refusals++;
        state.done++;
        failedUnseen(url, snap.check ? `the store showed a bot check ("${snap.check}")` : `the store refused it (HTTP ${snap.status})`);
        if (ctx.refusals >= REFUSAL_LIMIT) {
          await settle();
          halt(
            snap.check
              ? `The store showed a bot check instead of two pages in a row ("${snap.check}"). The run stopped so your address does not end up blocked. Open the store in a normal tab, pass the check, and try again later.`
              : `The store refused two pages in a row (HTTP ${snap.status}). The run stopped so your address does not end up blocked. Try again later, or more slowly.`,
          );
          return false;
        }
        continue;
      }
      ctx.refusals = 0;

      if (!snap.html) {
        failedUnseen(url, snap.error || "Could not read the page");
        ctx.collected++;
        state.done++;
        pushProgress();
        continue;
      }

      await settle();
      if (state.stopped) break;
      ctx.collected++;
      importing = ingest(url, snap, ctx);

      ctx.sinceRest++;
      if (ctx.sinceRest >= REST_EVERY && ctx.collected < ctx.limit && !state.stopped) {
        ctx.sinceRest = 0;
        const said = state.message;
        state.message = "Resting so the store does not notice a rhythm…";
        await sleep(REST_MS);
        state.message = said;
      }
    }
    await settle();
    return true;
  } finally {
    await settle();
  }
}

function newContext(limit, linksOnly) {
  return { limit, linksOnly, collected: 0, refusals: 0, sinceRest: 0, seen: [] };
}

/**
 * Collect a store from an address alone: the page as a background tab opens
 * it, then the store's sitemaps. What runs started without a tab get (the test
 * harness, older popups); the popup's "Collect this page" walks the admin's
 * own tab instead (`runPage`).
 */
async function run({ storeUrl, limit, linksOnly = false }) {
  let origin;
  try {
    origin = new URL(storeUrl).origin;
  } catch {
    halt("That does not look like a store address.");
    return;
  }

  begin(storeUrl, linksOnly, "planning");

  // The collect tab has to be there before anything is asked of the store —
  // failing here costs the store nothing, failing later wastes its bandwidth.
  const hello = await askPage("hello", {});
  if (!hello.ok) {
    halt(hello.error ?? NO_TAB);
    return;
  }

  const robotsTxt = (await fetchText(`${origin}/robots.txt`)) ?? "";
  if (state.stopped) return finish();

  // The page the admin pointed at, rendered. Its anchors are one source of
  // product addresses and its markup is the only one a store without a sitemap
  // has at all.
  state.message = "Reading the store…";
  const first = await snapshotPage(storeUrl);
  if (first.refused) {
    halt(
      first.check
        ? `The store showed a bot check instead of the first page ("${first.check}"). Nothing else was requested. Open it in a normal tab, pass the check, and try again.`
        : `The store refused the first page (HTTP ${first.status}). Nothing else was requested. Open it in a normal tab, clear whatever check it is showing, and try again.`,
    );
    return;
  }

  let html = first.html ?? "";
  let docs = [];
  const readDocs = new Set();
  /** Sitemaps the site has asked for and we have not fetched yet, best first. */
  let toFetch = [];
  /** Fetched sitemaps not yet sent, in pieces that each fit one plan call. */
  const pieces = [];
  const ctx = newContext(limit, linksOnly);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (state.stopped || ctx.collected >= limit) break;

    state.phase = "planning";
    state.message = "";
    const planned = await askPage("plan", {
      url: storeUrl,
      html,
      robotsTxt,
      sitemaps: docs,
      seen: ctx.seen,
      limit: limit - ctx.collected,
      // The popup's "Links only": the site then looks in this store for the
      // pieces we already have, and opens no other pages.
      linksOnly,
    });
    html = ""; // the start page is only worth sending once

    if (!planned.ok) {
      halt(planned.error ?? "The collect tab could not plan the run.");
      return;
    }

    const plan = planned.data ?? {};
    const urls = Array.isArray(plan.urls) ? plan.urls : [];
    state.delayMs = Math.max(Number(plan.delayMs) || MIN_DELAY_MS, MIN_DELAY_MS);
    state.planned = ctx.collected + urls.length;
    state.phase = "collecting";
    pushProgress();

    if (!(await collect(urls, ctx))) return;
    if (state.stopped || ctx.collected >= limit) break;

    // Sitemaps for the next round. The server names them, best first; we
    // fetch them. Newly named ones go ahead of older ones, because the server
    // ranks the products sitemap out of an index above everything else.
    const named = (Array.isArray(plan.fetchNext) ? plan.fetchNext : []).filter(
      (u) => typeof u === "string" && !readDocs.has(u) && !toFetch.includes(u),
    );
    toFetch = [...named, ...toFetch];

    // Only as much as one plan call can take. A store whose first sitemap
    // holds more products than the run asked for is never asked for the rest.
    // Fetching every named sitemap at once is how a Farfetch run ended up
    // handing Chrome a message bigger than it will carry.
    while (
      toFetch.length &&
      !state.stopped &&
      queuedBytes(pieces) < PLAN_SITEMAP_BUDGET &&
      pieces.length < PLAN_SITEMAP_DOCS
    ) {
      const docUrl = toFetch.shift();
      readDocs.add(docUrl);
      const xml = await fetchText(docUrl);
      if (xml) pieces.push(...sitemapPieces(docUrl, xml));
      await sleep(SITEMAP_GAP_MS);
    }
    if (state.stopped) break;

    docs = takePieces(pieces);
    if (!docs.length) break;
  }

  finish();
}

/** An address without its query and fragment: how the planner names a page. */
function pagePath(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

/** Load an address in a tab that is already open, and wait for it to finish. */
function navigate(tabId, url) {
  return new Promise((resolve) => {
    let started = false;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(ok);
    };
    // "complete" for the page being left can arrive after the update is asked
    // for; only one that follows a "loading" is the new page.
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") started = true;
      else if (started && info.status === "complete") done(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => done(started), PAGE_TIMEOUT_MS);
    mainFrameStatus.delete(tabId);
    chrome.tabs.update(tabId, { url }).catch(() => done(false));
  });
}

/**
 * Walk the listing in the admin's tab: every screen, every "Show more", every
 * page, noting each link on the way (listing.js). Returns the links in the
 * order they were seen and the structured data of each page walked.
 *
 * A whole-store run passes `site`, and the walk changes in three ways. It
 * does not keep everything for the end: every `site.batch` new links it hands
 * what it has to `site.onBatch`, which collects those pieces before the walk
 * scrolls on, so a category of fifty thousand is never one list. Its bounds
 * are the run's (`site.maxPages`, `site.maxMs` of walking, the collecting not
 * counted). And a tab that is not in front still turns numbered pages, which
 * need no scrolling; it waits `site.hiddenMs` only where the page has to be
 * scrolled to show more.
 */
async function walkListing(tabId, startUrl, limit, rules, robotsTxt, linksOnly, site = null) {
  const links = [];
  const known = new Set();
  const heads = [];
  let ldSize = 0;
  const visited = new Set([startUrl.split("#")[0]]);
  let started = Date.now();
  const maxMs = site ? site.maxMs : LISTING_MS;
  const maxPages = site ? site.maxPages : LISTING_PAGES;
  const maxLinks = site ? Infinity : LISTING_LINKS;
  const hiddenMs = site ? site.hiddenMs : HIDDEN_MS;
  /** Links and page heads already handed to `site.onBatch`. */
  let handed = 0;
  let headsHanded = 0;
  let halted = false;
  /** The page the tab is on: where a Resume starts again once its links are collected. */
  let onPageNow = startUrl;
  /** Hand the links not handed yet to the run; false when the run is over. */
  const flush = async () => {
    if (!site || handed >= links.length) return !state.stopped;
    const chunk = links.slice(handed);
    const newHeads = heads.slice(headsHanded);
    handed = links.length;
    headsHanded = heads.length;
    const t0 = Date.now();
    const ok = await site.onBatch(chunk, newHeads, [...visited].map(pagePath));
    // Collecting is not walking: the clock and the wait for the tab start
    // again where they were.
    started += Date.now() - t0;
    hiddenSince = 0;
    if (ok === false) halted = true;
    // Every link up to this page is collected: a Resume can start here. Not
    // at a page the walk turned to before its links were collected, or the
    // pieces of the pages before it would be skipped.
    else if (!state.stopped && site.onPage) site.onPage(onPageNow);
    state.phase = "listing";
    return ok !== false && !state.stopped;
  };
  let pages = 1;
  let first = true;
  let initial = -1;
  let hiddenSince = 0;
  let misses = 0;
  let lastError = "";
  let note = "";
  let partial = false;
  /** The walk ended because the tab stayed out of sight; and whether it was ever in sight. */
  let unseen = false;
  let seenTab = false;

  // A run that asked for a number of pieces takes them from the page as the
  // admin sees it: it looks before it scrolls, and scrolls only while the page
  // shows fewer than that. Up to 1.0.17 it kept scrolling until it had seen
  // twice the number in new links, which on most stores was the whole page and
  // the next one too. "Everything on this page" walks to the end as before.
  const counting = limit < MAX_LIMIT;
  let checkedAt = -1;
  /** Does the page already show as many pieces as were asked for? The planner counts. */
  const enough = async () => {
    if (!counting || links.length === checkedAt) return false;
    checkedAt = links.length;
    const looked = await askPage("plan", {
      url: startUrl,
      html: planHtml(heads, links),
      robotsTxt,
      sitemaps: [],
      seen: [],
      limit: MAX_LIMIT,
      linksOnly,
    });
    if (!looked.ok || !Array.isArray(looked.data?.urls)) return false;
    const listing = new Set([...visited].map(pagePath));
    return looked.data.urls.filter((u) => !listing.has(pagePath(u))).length >= limit;
  };

  state.listing = { pages, links: 0 };
  pushProgress();

  while (!state.stopped) {
    if (Date.now() - started > maxMs) {
      note = `The page was still loading more after ${Math.round(maxMs / 60_000)} minutes; collecting what it had shown by then.`;
      break;
    }

    let res = null;
    try {
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        func: listingStep,
        // The run's first look starts the page's memory afresh, and in a
        // counting run does not scroll.
        args: [{ first, reset: initial < 0, scroll: !(counting && initial < 0), hiddenNext: !!site }],
      });
      res = out?.result ?? null;
    } catch (err) {
      lastError = err?.message ?? "";
    }

    if (!res || !res.ok) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) {
        if (!links.length) return { error: "The store tab was closed before it could be read." };
        note = "The store tab was closed; collecting what it had shown by then.";
        break;
      }
      // A "Show more" that is a real link takes the tab to the next page.
      if (tab.status === "loading") {
        await waitForLoad(tabId);
        await sleep(SETTLE_MS);
        first = true;
        continue;
      }
      if (++misses > 3) {
        if (!links.length) return { error: `The store page could not be read${lastError ? ` (${lastError})` : ""}.` };
        break;
      }
      await sleep(500);
      continue;
    }
    misses = 0;
    if (res.visible) seenTab = true;

    for (const url of res.links) {
      if (known.has(url) || links.length >= maxLinks) continue;
      known.add(url);
      links.push(url);
    }
    if (first) {
      first = false;
      const opening = initial < 0;
      if (opening) initial = links.length;
      if (res.head) {
        const ld = [];
        for (const text of res.head.ld || []) {
          if (ldSize + text.length > LISTING_LD) break;
          ldSize += text.length;
          ld.push(text);
        }
        heads.push({ ld, ogType: res.head.ogType || "" });
      }
      // A page whose markup calls it one product is that product, unless it
      // already shows a grid: then it is a listing dressed as a product. The
      // planner says which links are pieces; the page is asked once, before
      // any scrolling, so a product page is not walked at all.
      if (opening && res.saysProduct) {
        const looked = await askPage("plan", {
          url: startUrl,
          html: planHtml(heads, links),
          robotsTxt,
          sitemaps: [],
          seen: [],
          limit: MAX_LIMIT,
          linksOnly,
        });
        const here = pagePath(startUrl);
        const others = (looked.ok && Array.isArray(looked.data?.urls) ? looked.data.urls : []).filter(
          (u) => pagePath(u) !== here,
        );
        if (looked.ok && others.length < GRID_MIN) {
          return { links, heads, pages, partial, note, product: true, seenTab, walked: [here] };
        }
      }
    }
    state.listing = { pages, links: links.length };

    // Enough already: no further scrolling, whether or not the tab is in front.
    if (await enough()) {
      partial = true;
      break;
    }

    // A whole-store run collects as it goes.
    if (site && links.length - handed >= site.batch && !(await flush())) break;

    // A numbered page needs no scrolling: a whole-store run turns it in a
    // tab nobody is looking at.
    const turnHidden = !res.visible && !!site && !!res.next && !visited.has(res.next);
    if (!res.visible && !turnHidden) {
      hiddenSince = hiddenSince || Date.now();
      state.message = KEEP_IN_FRONT;
      pushProgress();
      if (Date.now() - hiddenSince > hiddenMs) {
        note = "The store tab stayed in the background; collecting what it had shown by then.";
        unseen = true;
        break;
      }
      await sleep(1000);
      continue;
    }
    hiddenSince = 0;
    if (state.message === KEEP_IN_FRONT) state.message = "";
    pushProgress();

    if (links.length >= maxLinks) break;
    if (!res.exhausted && !turnHidden) continue;

    const next = res.next;
    if (!next || visited.has(next) || pages >= maxPages) break;
    if (!robotsAllows(rules, next)) {
      note = `robots.txt does not allow page ${pages + 1} of this listing; collecting the ${pages === 1 ? "first page" : `first ${pages} pages`}.`;
      break;
    }
    visited.add(next);
    await politePause();
    if (state.stopped) break;
    const loaded = await navigate(tabId, next);
    const status = mainFrameStatus.get(tabId) ?? 0;
    if (REFUSAL_STATUSES.has(status)) {
      note = `The store refused page ${pages + 1} (HTTP ${status}); collecting the pages before it.`;
      break;
    }
    if (!loaded) break;
    await sleep(SETTLE_MS);
    pages++;
    first = true;
    state.listing = { pages, links: links.length };
    onPageNow = next;
    pushProgress();
  }

  if (site && !halted && !state.stopped) await flush();
  // Back where the admin started, rather than on the listing's last page. A
  // whole-store run goes on to its next category instead.
  if (pages > 1 && !site) chrome.tabs.update(tabId, { url: startUrl }).catch(() => {});
  return { links, heads, pages, partial, note, product: false, halted, unseen, seenTab, walked: [...visited].map(pagePath) };
}

/**
 * Collect the page the admin is on: walk it to the end in their tab, plan
 * every piece it showed, then open them one by one in the background.
 */
async function runPage({ tabId, storeUrl, limit, linksOnly = false }) {
  let origin;
  try {
    origin = new URL(storeUrl).origin;
  } catch {
    halt("That does not look like a store address.");
    return;
  }

  begin(storeUrl, linksOnly, "listing");

  const hello = await askPage("hello", {});
  if (!hello.ok) {
    halt(hello.error ?? NO_TAB);
    return;
  }

  const robotsTxt = (await fetchText(`${origin}/robots.txt`)) ?? "";
  const rules = robotsRules(robotsTxt);
  state.delayMs = Math.max(rules.crawlDelayMs ?? 0, MIN_DELAY_MS);
  if (state.stopped) return finish();

  const walk = await walkListing(tabId, storeUrl, limit, rules, robotsTxt, linksOnly);
  if (state.stopped) return finish();
  if (walk.error) {
    halt(walk.error);
    return;
  }

  state.phase = "planning";
  state.message = "";
  const planned = await askPage("plan", {
    url: storeUrl,
    html: planHtml(walk.heads, walk.links),
    robotsTxt,
    sitemaps: [],
    seen: [],
    // Every piece the page showed, so the admin is told how many there were;
    // the run then takes as many as they asked for.
    limit: MAX_LIMIT,
    linksOnly,
  });
  if (!planned.ok) {
    halt(planned.error ?? "The collect tab could not plan the run.");
    return;
  }

  const plan = planned.data ?? {};
  let urls = Array.isArray(plan.urls) ? plan.urls : [];
  if (walk.product) {
    // A product page: the page is the piece, and what it recommends is not.
    // It is opened again in the background, so robots.txt has its say: the
    // planner's own entry for it has passed it, and without one we ask.
    const here = pagePath(storeUrl);
    const own = urls.find((u) => pagePath(u) === here) ?? (robotsAllows(rules, storeUrl) ? storeUrl.split("#")[0] : "");
    urls = own ? [own] : [];
  } else {
    // A listing is never one of its own pieces. Up to 1.0.14 a category the
    // planner took for a product by its address (stores that number their
    // categories, `…/jackets-c1712066.html`) came back as the only "piece",
    // and was imported with the store's logo for a photo. Its other pages
    // (`?page=2` names the same path) are the listing too.
    const listing = new Set(walk.walked);
    urls = urls.filter((u) => !listing.has(pagePath(u)));
  }
  if (!urls.length) {
    halt(NOTHING_FOUND);
    return;
  }

  state.found = urls.length;
  state.foundAtLeast = walk.partial;
  state.delayMs = Math.max(Number(plan.delayMs) || MIN_DELAY_MS, MIN_DELAY_MS);
  const take = urls.slice(0, limit);
  state.planned = take.length;
  state.phase = "collecting";
  state.message = walk.note;
  pushProgress();

  if (!(await collect(take, newContext(limit, linksOnly)))) return;
  finish();
}

/** Open again the pages the last run could not read or import. */
async function runRetry(last) {
  const wanted = (last.failures || []).map((f) => f && f.url).filter((u) => typeof u === "string");
  let origin;
  try {
    origin = new URL(last.store || wanted[0]).origin;
  } catch {
    halt("The last run's store address is unusable.");
    return;
  }

  begin(last.store || wanted[0], last.linksOnly === true, "planning");

  const hello = await askPage("hello", {});
  if (!hello.ok) {
    halt(hello.error ?? NO_TAB);
    return;
  }
  const robotsTxt = (await fetchText(`${origin}/robots.txt`)) ?? "";
  if (state.stopped) return finish();

  // Planned again rather than trusted: robots.txt may have changed, and the
  // pace comes from it. A whole-store run can leave more failed pages than
  // one plan call answers for, so they are planned a chunk at a time.
  const set = new Set(wanted);
  const urls = [];
  let plan = {};
  for (let i = 0; i < wanted.length; i += PLAN_LINKS) {
    const planned = await askPage("plan", {
      url: state.store,
      html: planHtml([], wanted.slice(i, i + PLAN_LINKS)),
      robotsTxt,
      sitemaps: [],
      seen: [],
      limit: MAX_LIMIT,
      linksOnly: state.linksOnly,
    });
    if (!planned.ok) {
      halt(planned.error ?? "The collect tab could not plan the run.");
      return;
    }
    plan = planned.data ?? {};
    for (const u of Array.isArray(plan.urls) ? plan.urls : []) if (set.has(u) && !urls.includes(u)) urls.push(u);
  }
  state.found = urls.length;
  state.delayMs = Math.max(Number(plan.delayMs) || MIN_DELAY_MS, MIN_DELAY_MS);
  state.planned = urls.length;
  state.phase = "collecting";
  pushProgress();

  if (!(await collect(urls, newContext(Infinity, state.linksOnly)))) return;
  finish();
}

// ── The whole store ──────────────────────────────────────────────────────────

/** New links a whole-store walk gathers before it collects their pieces. */
const SITE_BATCH = 120;
/** Pages of one category a whole-store run turns, at most. */
const SITE_PAGES = 5_000;
/** Time spent walking one category, the collecting in between not counted. */
const SITE_WALK_MS = 60 * 60_000;
/**
 * How long a category that only loads more as it is scrolled waits for its
 * tab to come back to the front. Short, because a run of a thousand
 * categories cannot wait five minutes at each, and what such a category did
 * not show is still in the store's sitemaps, read last. Once one category has
 * waited that long in vain, the next ones only look (`SITE_UNSEEN_MS`) until
 * the tab is seen again: the admin is not watching, and a night of minutes
 * would add up to hours.
 */
const SITE_HIDDEN_MS = 60_000;
const SITE_UNSEEN_MS = 5_000;
/** Sitemap documents one run reads, at most. */
const SITE_DOCS = 5_000;
/**
 * Rows the collect tab lists before a whole-store run gives it a fresh page.
 * The tab keeps every row it is sent, and six hundred thousand of them would
 * stop it; it is greeted again, which clears it, at every category and every
 * thousand pieces.
 */
const SCREEN_ROWS = 1_000;
/** Where a whole-store run writes down how far it has got. */
const SITE_KEY = "siteRun";

const RESUME_HINT = "Resume carries on from here: open the store, click Goo Collect, press Resume.";

/** Every piece the whole-store run has opened. */
const seenPieces = new SeenStore();

/** The whole-store run going now, so a halt anywhere writes it down. */
let currentSite = null;

async function loadSiteRun() {
  try {
    const stored = await chrome.storage.local.get(SITE_KEY);
    const run = stored[SITE_KEY];
    return run && typeof run === "object" && Array.isArray(run.categories) ? run : null;
  } catch {
    return null;
  }
}

async function saveSiteRun(run) {
  try {
    await chrome.storage.local.set({ [SITE_KEY]: run });
  } catch {
    /* the run goes on; only a later Resume would start further back */
  }
}

/** Write down where the run is, and what it has come to so far. */
async function keepSite(run, status = "running") {
  run.done = state.done;
  run.counts = { ...state.counts };
  run.status = status;
  await saveSiteRun(run);
  await saveLastRun();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** The language most of the pieces walked so far live under, or null. */
function commonLocale(locales) {
  let best = null;
  let most = 0;
  for (const [prefix, n] of Object.entries(locales || {})) {
    if (n > most) {
      best = prefix;
      most = n;
    }
  }
  return best;
}

function localeOf(url) {
  try {
    return localePrefix(new URL(url).pathname);
  } catch {
    return "";
  }
}

/**
 * The tab a whole-store run walks: the admin's own, when it is on the store,
 * or a new one in front when they resume from somewhere else.
 */
async function storeTab(tabId, host, url) {
  const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (tab && tab.url && hostOf(tab.url) === host) return { id: tab.id, opened: false };
  try {
    const made = await chrome.tabs.create({ url, active: true });
    await waitForLoad(made.id);
    return { id: made.id, opened: true };
  } catch {
    return { id: null, opened: false };
  }
}

/**
 * Collect the whole store: its menu's categories one by one in the admin's
 * tab, each piece once, then its sitemaps for the pieces no category showed.
 *
 * Everything the run needs to carry on is written down as it goes (`SITE_KEY`
 * and the SeenStore). `resume` picks up the last run where it stopped, halted
 * or was cut off: the category and page it was on, the sitemap and the piece
 * of it.
 */
async function runSite({ tabId, storeUrl, linksOnly = false, resume = false }) {
  let run = null;
  if (resume) {
    run = await loadSiteRun();
    if (!run || run.stage === "done") {
      halt("There is no whole-store run to resume.");
      return;
    }
    storeUrl = run.store;
    linksOnly = run.linksOnly === true;
  }

  let origin;
  let host;
  try {
    const u = new URL(storeUrl);
    origin = u.origin;
    host = hostOf(storeUrl);
  } catch {
    halt("That does not look like a store address.");
    return;
  }
  const startUrl = storeUrl.split("#")[0];

  const previous = run ? await lastRun() : null;
  begin(startUrl, linksOnly, "listing");
  state.site = {
    stage: run ? run.stage : "menu",
    categories: run ? run.categories.length : 0,
    index: run ? run.index : 0,
    label: "",
    url: "",
    sitemapsRead: run && run.sweep ? run.sweep.read.length : 0,
    sitemapsQueued: run && run.sweep ? run.sweep.queue.length : 0,
    startedAt: run ? run.startedAt : Date.now(),
    resumedAt: Date.now(),
    doneAtResume: run ? run.done || 0 : 0,
  };
  if (run) {
    state.done = run.done || 0;
    state.counts = { ...state.counts, ...(run.counts || {}) };
    if (previous && hostOf(previous.store) === host && Array.isArray(previous.failures)) {
      state.failures = previous.failures.slice(0, SITE_FAILURES);
    }
  }

  const hello = await askPage("hello", {});
  if (!hello.ok) {
    halt(hello.error ?? NO_TAB);
    return;
  }

  const robotsTxt = (await fetchText(`${origin}/robots.txt`)) ?? "";
  const rules = robotsRules(robotsTxt);
  state.delayMs = Math.max(rules.crawlDelayMs ?? 0, MIN_DELAY_MS);
  if (state.stopped) return finish();

  const target0 = run ? run.pageUrl || run.categories[run.index]?.url || startUrl : startUrl;
  const tab = await storeTab(tabId, host, target0);
  if (tab.id == null) {
    halt("Could not open a tab on the store.");
    return;
  }
  tabId = tab.id;

  const ctx = newContext(Infinity, linksOnly);
  ctx.seen = null;
  ctx.mark = (url) => seenPieces.add(url).catch(() => {});

  // ── The menu ────────────────────────────────────────────────────────────
  if (!run) {
    await seenPieces.clear().catch(() => {});
    state.message = "";
    pushProgress();
    let menu = null;
    try {
      const [out] = await chrome.scripting.executeScript({ target: { tabId }, func: menuStep });
      menu = out?.result ?? null;
    } catch {
      menu = null;
    }
    // The page the admin started on comes first: it is a category too, or
    // the home page with its own pieces. The menu's categories go only where
    // robots.txt lets the run go.
    const categories = [
      { url: startUrl, label: "This page", where: "start" },
      ...categoryCandidates(menu && menu.links, startUrl).filter((c) => robotsAllows(rules, c.url)),
    ];
    run = {
      store: startUrl,
      linksOnly,
      startedAt: state.site.startedAt,
      stage: "categories",
      categories,
      index: 0,
      pageUrl: "",
      sweep: null,
      locales: {},
      done: 0,
      counts: { ...state.counts },
      status: "running",
    };
  }
  currentSite = run;
  await keepSite(run);

  /** A category is never a piece: a store that numbers its categories like pieces would have them collected. */
  const categoryPaths = new Set(run.categories.map((c) => pagePath(c.url)));

  /** The planner's answer for one call, or null when the run has had to halt. */
  const plan = async (payload) => {
    state.phase = "planning";
    const planned = await askPage("plan", {
      robotsTxt,
      sitemaps: [],
      seen: [],
      limit: MAX_LIMIT,
      linksOnly,
      html: "",
      ...payload,
    });
    if (!planned.ok) {
      halt(planned.error ?? "The collect tab could not plan the run.");
      return null;
    }
    const data = planned.data ?? {};
    state.delayMs = Math.max(Number(data.delayMs) || MIN_DELAY_MS, MIN_DELAY_MS);
    return data;
  };

  let screenFrom = state.done;
  /** Clear the collect tab's rows: at every category, and every SCREEN_ROWS pieces. */
  const freshScreen = async (force) => {
    if (!force && state.done - screenFrom < SCREEN_ROWS) return true;
    screenFrom = state.done;
    state.planned = 0;
    state.found = 0;
    const greeted = await askPage("hello", {});
    if (!greeted.ok) {
      halt(greeted.error ?? NO_TAB);
      return false;
    }
    return true;
  };

  /** Open the pieces among `urls` not opened before. False when the run is over. */
  const collectNew = async (urls) => {
    const fresh = await seenPieces.fresh(urls).catch(() => urls);
    if (!fresh.length) return !state.stopped;
    if (!(await freshScreen(false))) return false;
    state.planned += fresh.length;
    state.phase = "collecting";
    pushProgress();
    const ok = await collect(fresh, ctx);
    if (!ok) return false;
    await keepSite(run);
    return !state.stopped;
  };

  /** What a category's walk hands over: planned a chunk at a time, then collected. */
  const walkBatch = (cat) => async (chunk, heads, walked) => {
    const listing = new Set(walked);
    for (let i = 0; i < chunk.length; i += PLAN_LINKS) {
      const data = await plan({ url: cat.url, html: planHtml(i === 0 ? heads : [], chunk.slice(i, i + PLAN_LINKS)) });
      if (!data) return false;
      const urls = (Array.isArray(data.urls) ? data.urls : []).filter(
        (u) => !listing.has(pagePath(u)) && !categoryPaths.has(pagePath(u)),
      );
      for (const u of urls) {
        const prefix = localeOf(u);
        run.locales[prefix] = (run.locales[prefix] || 0) + 1;
      }
      if (!(await collectNew(urls))) return false;
    }
    return true;
  };

  // ── The categories ──────────────────────────────────────────────────────
  /** Where the tab already is: the admin's page on a new run, the tab just opened on a resume. */
  let at = !resume ? startUrl : tab.opened ? target0 : "";
  /** The last walk gave up on a tab nobody was looking at. */
  let unseen = false;
  for (; run.stage === "categories" && run.index < run.categories.length && !state.stopped; run.index++, run.pageUrl = "") {
    const cat = run.categories[run.index];
    const target = run.pageUrl || cat.url;
    const there = at === target;
    at = "";
    Object.assign(state.site, {
      stage: "categories",
      categories: run.categories.length,
      index: run.index,
      label: cat.label,
      url: cat.url,
    });
    state.phase = "listing";
    state.listing = { pages: 1, links: 0 };
    state.message = "";
    await keepSite(run);

    // A link in the menu that a walk before it has already collected as a piece.
    if (cat.where !== "start" && !(await seenPieces.fresh([pagePath(cat.url)]).catch(() => [cat.url])).length) continue;

    if (!(await freshScreen(true))) return;
    pushProgress();

    if (!(await chrome.tabs.get(tabId).catch(() => null))) {
      halt("The store tab was closed.");
      return;
    }
    if (!there) {
      await politePause();
      if (state.stopped) break;
      const loaded = await navigate(tabId, target);
      const status = mainFrameStatus.get(tabId) ?? 0;
      if (REFUSAL_STATUSES.has(status)) {
        ctx.refusals++;
        if (ctx.refusals >= REFUSAL_LIMIT) {
          halt(`The store refused two pages in a row (HTTP ${status}). The run stopped so your address does not end up blocked. Try again later.`);
          return;
        }
        state.message = `The store refused ${cat.label} (HTTP ${status}); going on to the next category.`;
        continue;
      }
      if (!loaded) {
        state.message = `${cat.label} did not load; going on to the next category.`;
        continue;
      }
      ctx.refusals = 0;
      await sleep(SETTLE_MS);
    }
    if (state.stopped) break;

    const walk = await walkListing(tabId, target, MAX_LIMIT, rules, robotsTxt, linksOnly, {
      batch: SITE_BATCH,
      maxPages: SITE_PAGES,
      maxMs: SITE_WALK_MS,
      hiddenMs: unseen ? SITE_UNSEEN_MS : SITE_HIDDEN_MS,
      onPage: (url) => {
        run.pageUrl = url;
        void saveSiteRun(run);
      },
      onBatch: walkBatch(cat),
    });
    if (state.stopped) break;
    if (walk.halted || !state.running) return;
    // Out of sight until a walk finds the tab in front again.
    unseen = !!walk.unseen || (unseen && !walk.seenTab);
    if (walk.error) {
      state.message = `${cat.label}: ${walk.error} Going on to the next category.`;
    } else if (walk.product) {
      // A menu link to one piece: the walk recognised a product page.
      if (!(await collectNew([pagePath(target)]))) {
        if (state.stopped) break;
        return;
      }
    }
  }
  if (state.stopped) return endSite(run, tabId);
  if (run.stage === "categories") {
    run.stage = "sitemaps";
    run.pageUrl = "";
    run.sweep = null;
    await keepSite(run);
  }

  // ── The sitemaps ────────────────────────────────────────────────────────
  // Last, for what no category led to: a piece only search finds, a category
  // the menu does not list. Only in the language the pieces were walked in,
  // or the run would collect the store again in every language it has.
  Object.assign(state.site, { stage: "sitemaps", label: "", url: "" });
  state.listing = null;
  state.message = "";
  if (!(await freshScreen(true))) return;
  if (!run.sweep) {
    const first = await plan({ url: `${origin}/`, limit: 1 });
    if (!first) return;
    const named = (first.robots && Array.isArray(first.robots.sitemaps) ? first.robots.sitemaps : []).filter(
      (u) => hostOf(u) === host,
    );
    run.sweep = {
      queue: named.length ? named : Array.isArray(first.fetchNext) ? first.fetchNext : [],
      read: [],
      current: "",
      piece: 0,
    };
    await keepSite(run);
  }
  const sweep = run.sweep;
  const locale = commonLocale(run.locales) ?? localePrefix(new URL(startUrl).pathname);
  while (!state.stopped && (sweep.current || sweep.queue.length) && sweep.read.length < SITE_DOCS) {
    if (!sweep.current) {
      sweep.current = sweep.queue.shift();
      sweep.piece = 0;
    }
    const docUrl = sweep.current;
    Object.assign(state.site, { sitemapsRead: sweep.read.length, sitemapsQueued: sweep.queue.length + 1 });
    state.phase = "planning";
    pushProgress();
    await keepSite(run);
    await sleep(SITEMAP_GAP_MS);
    if (state.stopped) break;

    const xml = await fetchText(docUrl);
    if (xml && isSitemapIndex(xml)) {
      for (const child of sitemapChildren(xml, host)) {
        if (child !== docUrl && !sweep.read.includes(child) && !sweep.queue.includes(child)) sweep.queue.push(child);
      }
    } else if (xml) {
      const cut = sitemapPieces(docUrl, xml, PLAN_SITEMAP_BUDGET, SWEEP_ENTRIES);
      while (sweep.piece < cut.length && !state.stopped) {
        const piece = cut[sweep.piece];
        const data = await plan({ url: `${origin}/`, sitemaps: [{ url: piece.url, xml: piece.xml }] });
        if (!data) return;
        const urls = (Array.isArray(data.urls) ? data.urls : []).filter(
          (u) => localeOf(u) === locale && !categoryPaths.has(pagePath(u)),
        );
        if (!(await collectNew(urls))) {
          if (state.stopped) break;
          return;
        }
        sweep.piece++;
        await keepSite(run);
      }
      if (state.stopped) break;
    }
    sweep.read.push(docUrl);
    sweep.current = "";
    sweep.piece = 0;
  }
  Object.assign(state.site, { sitemapsRead: sweep.read.length, sitemapsQueued: sweep.queue.length });
  if (!state.stopped) run.stage = "done";
  return endSite(run, tabId);
}

/** A whole-store run that stopped or reached the end: written down, and the tab back where it began. */
async function endSite(run, tabId) {
  const done = run.stage === "done";
  if (done) {
    state.site.stage = "done";
    state.message = "";
    chrome.tabs.update(tabId, { url: run.store }).catch(() => {});
  }
  await keepSite(run, done ? "done" : "stopped");
  currentSite = null;
  finish();
}

/** Retry, asked for by the popup or by the collect tab's button. */
async function retry() {
  if (state.running) return { ok: false, error: "A run is already going." };
  const last = await lastRun();
  if (!last || !Array.isArray(last.failures) || !last.failures.length) {
    return { ok: false, error: "Nothing to retry: the last run had no failed pages." };
  }
  runRetry(last).catch((err) => halt(err?.message ?? "The run failed unexpectedly."));
  return { ok: true };
}

function stop() {
  state.stopped = true;
  state.phase = "stopped";
  wakeAll();
}

// ── Messages ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return undefined;
  // Anything addressed to the bridge is delivered to a tab, not to us.
  if (msg.target === "bridge") return undefined;

  switch (msg.type) {
    case "bridge-ready":
      void rememberStudioTab(sender?.tab?.id);
      sendResponse({ ok: true });
      return undefined;

    case "state":
      sendResponse(publicState());
      return undefined;

    case "connect":
      // The popup asks before starting, so a broken link is mended — or named —
      // while the admin is still looking, not a minute into the run.
      reconnect().then((res) =>
        sendResponse(typeof res === "number" ? { ok: true } : { ok: false, error: res?.error ?? NO_TAB }),
      );
      return true;

    case "stop":
      stop();
      sendResponse({ ok: true });
      return undefined;

    case "start": {
      if (state.running) {
        sendResponse({ ok: false, error: "A run is already going." });
        return undefined;
      }
      const storeUrl = msg.payload?.storeUrl;
      const limit = Math.max(1, Math.min(Number(msg.payload?.limit) || 30, MAX_LIMIT));
      const linksOnly = msg.payload?.linksOnly === true;
      // The popup names the tab the admin is looking at: that page is walked
      // in place. Without one, the address alone is collected as before.
      const tabId = msg.payload?.tabId;
      const job = Number.isInteger(tabId)
        ? runPage({ tabId, storeUrl, limit, linksOnly })
        : run({ storeUrl, limit, linksOnly });
      job.catch((err) => {
        halt(err?.message ?? "The run failed unexpectedly.");
      });
      sendResponse({ ok: true });
      return undefined;
    }

    case "site": {
      // "Collect the whole store", or Resume, from the popup.
      if (state.running) {
        sendResponse({ ok: false, error: "A run is already going." });
        return undefined;
      }
      const p = msg.payload || {};
      runSite({
        tabId: Number.isInteger(p.tabId) ? p.tabId : null,
        storeUrl: typeof p.storeUrl === "string" ? p.storeUrl : "",
        linksOnly: p.linksOnly === true,
        resume: p.resume === true,
      }).catch((err) => {
        halt(err?.message ?? "The run failed unexpectedly.");
      });
      sendResponse({ ok: true });
      return undefined;
    }

    case "retry":
      // From the popup, or from the collect tab's button through the bridge.
      // Either way only the pages this worker itself recorded as failed.
      retry().then((res) => {
        // Said on the collect tab only when nothing is running there: a run in
        // progress is not halted by a Retry pressed beside it.
        if (!res.ok && sender?.tab && !state.running) void tellPage("error", { message: res.error });
        sendResponse(res);
      });
      return true;

    default:
      return undefined;
  }
});

// A collect tab that goes away should not be talked to.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.studioTabId) void rememberStudioTab(null);
});
