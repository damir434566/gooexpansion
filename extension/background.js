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

/** Give up on a page that will not finish loading. */
const PAGE_TIMEOUT_MS = 45_000;
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
    found: state.found,
    foundAtLeast: state.foundAtLeast,
    listing: state.listing,
    message: state.message,
  });
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

  try {
    const loaded = await waitForLoad(tabId);
    const status = mainFrameStatus.get(tabId) ?? 0;

    if (REFUSAL_STATUSES.has(status)) return { refused: true, status };
    if (status >= 400) return { error: `HTTP ${status}`, status };
    if (!loaded) return { error: "The page did not finish loading" };

    await sleep(SETTLE_MS);
    if (state.stopped) return { error: "Stopped" };

    const read = async () => {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["snapshot.js"],
      });
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
      await waitForLoad(tabId);
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

const KEEP_IN_FRONT =
  "Bring the store tab back to the front. A store only loads more of its page while you can see it.";
const NOTHING_FOUND =
  "No pieces were found on this page. Open a page with a grid of products (a category, a brand, a search) and try again.";

/** Where every kind of run starts from. */
function begin(storeUrl, linksOnly, phase) {
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
    counts: { new: 0, updated: 0, skipped: 0, failed: 0 },
    failures: [],
    delayMs: MIN_DELAY_MS,
  });
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
    failures: state.failures.slice(0, MAX_FAILURES),
    linksOnly: state.linksOnly,
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
  if (status === "failed" && state.failures.length < MAX_FAILURES) {
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
  state.running = false;
  state.phase = "halted";
  state.message = message;
  void tellPage("error", { message });
  void saveLastRun();
}

function finish() {
  state.running = false;
  state.phase = state.stopped ? "stopped" : "done";
  void tellPage("done", {});
  void saveLastRun();
}

/**
 * Open each address in turn, at the store's pace, and hand what it shows to
 * the collect tab. Every kind of run ends here. Returns false when the store
 * made the run stop: two refusals in a row.
 */
async function collect(urls, ctx) {
  for (const url of urls) {
    if (state.stopped || ctx.collected >= ctx.limit) break;
    ctx.seen.push(url);

    await politePause();
    if (state.stopped) break;

    const snap = await snapshotPage(url);
    // Stopped while the page was open: not a failure, and nothing to retry.
    if (state.stopped) break;

    if (snap.refused) {
      ctx.refusals++;
      state.done++;
      failedUnseen(url, snap.check ? `the store showed a bot check ("${snap.check}")` : `the store refused it (HTTP ${snap.status})`);
      if (ctx.refusals >= REFUSAL_LIMIT) {
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
      continue;
    }

    const ingested = await askPage("ingest", {
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
    });
    ctx.collected++;
    state.done++;
    if (ingested.ok) {
      const result = ingested.data?.result;
      record(url, result?.status || "imported", result?.reason);
    } else if (!state.stopped) {
      record(url, "failed", ingested.error);
    }
    pushProgress();

    ctx.sinceRest++;
    if (ctx.sinceRest >= REST_EVERY && ctx.collected < ctx.limit && !state.stopped) {
      ctx.sinceRest = 0;
      const said = state.message;
      state.message = "Resting so the store does not notice a rhythm…";
      await sleep(REST_MS);
      state.message = said;
    }
  }
  return true;
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
 */
async function walkListing(tabId, startUrl, limit, rules) {
  const links = [];
  const known = new Set();
  const heads = [];
  let ldSize = 0;
  const visited = new Set([startUrl.split("#")[0]]);
  const started = Date.now();
  let pages = 1;
  let first = true;
  let initial = -1;
  let hiddenSince = 0;
  let misses = 0;
  let lastError = "";
  let note = "";
  let partial = false;

  state.listing = { pages, links: 0 };
  pushProgress();

  while (!state.stopped) {
    if (Date.now() - started > LISTING_MS) {
      note = "The page was still loading more after ten minutes; collecting what it had shown by then.";
      break;
    }

    let res = null;
    try {
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        func: listingStep,
        args: [{ first }],
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

    for (const url of res.links) {
      if (known.has(url) || links.length >= LISTING_LINKS) continue;
      known.add(url);
      links.push(url);
    }
    if (first) {
      first = false;
      if (initial < 0) initial = links.length;
      if (res.head) {
        const ld = [];
        for (const text of res.head.ld || []) {
          if (ldSize + text.length > LISTING_LD) break;
          ldSize += text.length;
          ld.push(text);
        }
        heads.push({ ld, ogType: res.head.ogType || "" });
      }
    }
    state.listing = { pages, links: links.length };

    if (!res.visible) {
      hiddenSince = hiddenSince || Date.now();
      state.message = KEEP_IN_FRONT;
      pushProgress();
      if (Date.now() - hiddenSince > HIDDEN_MS) {
        note = "The store tab stayed in the background; collecting what it had shown by then.";
        break;
      }
      await sleep(1000);
      continue;
    }
    hiddenSince = 0;
    if (state.message === KEEP_IN_FRONT) state.message = "";
    pushProgress();

    if (links.length >= LISTING_LINKS) break;
    // A run that asked for a few pieces does not need the whole category.
    // Links are not all pieces, so it reads well past the number first.
    if (limit < MAX_LIMIT && links.length - initial >= limit * 2 + 20) {
      partial = true;
      break;
    }
    if (!res.exhausted) continue;

    const next = res.next;
    if (!next || visited.has(next) || pages >= LISTING_PAGES) break;
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
    pushProgress();
  }

  // Back where the admin started, rather than on the listing's last page.
  if (pages > 1) chrome.tabs.update(tabId, { url: startUrl }).catch(() => {});
  return { links, heads, pages, partial, note };
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

  const walk = await walkListing(tabId, storeUrl, limit, rules);
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
  // On a product page the page is the piece; what it recommends is not.
  if (plan.isSingleProduct) urls = urls.slice(0, 1);
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
  // pace comes from it.
  const planned = await askPage("plan", {
    url: state.store,
    html: planHtml([], wanted),
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
  const plan = planned.data ?? {};
  const set = new Set(wanted);
  const urls = (Array.isArray(plan.urls) ? plan.urls : []).filter((u) => set.has(u));
  state.found = urls.length;
  state.delayMs = Math.max(Number(plan.delayMs) || MIN_DELAY_MS, MIN_DELAY_MS);
  state.planned = urls.length;
  state.phase = "collecting";
  pushProgress();

  if (!(await collect(urls, newContext(MAX_LIMIT, state.linksOnly)))) return;
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
