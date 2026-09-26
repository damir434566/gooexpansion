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

/** Give up on a page that will not finish loading. */
const PAGE_TIMEOUT_MS = 45_000;
/** Let a loaded page settle before reading it. */
const SETTLE_MS = 500;
/** Planning rounds before we call a store done. */
const MAX_ROUNDS = 12;
/** Pause between sitemap fetches — cheap requests, but still requests. */
const SITEMAP_GAP_MS = 400;

// ── Run state ────────────────────────────────────────────────────────────────

const state = {
  running: false,
  stopped: false,
  store: "",
  phase: "idle",
  message: "",
  planned: 0,
  done: 0,
  imported: 0,
  failed: 0,
  delayMs: MIN_DELAY_MS,
  studioTabId: null,
};

function publicState() {
  return { ...state };
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

/** Ask the collect tab to call the API, and wait for what it got back. */
async function askPage(type, payload) {
  const tabId = await studioTab();
  if (tabId == null) return { ok: false, error: NO_TAB };
  try {
    const res = await chrome.tabs.sendMessage(tabId, { target: "bridge", type, payload });
    return res ?? { ok: false, error: "The collect tab did not answer" };
  } catch {
    await rememberStudioTab(null);
    return { ok: false, error: NO_TAB };
  }
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

    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["snapshot.js"],
    });
    const result = injected?.result;
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

function halt(message) {
  state.running = false;
  state.phase = "halted";
  state.message = message;
  void tellPage("error", { message });
}

function finish() {
  state.running = false;
  state.phase = state.stopped ? "stopped" : "done";
  void tellPage("done", {});
}

async function run({ storeUrl, limit }) {
  let origin;
  try {
    origin = new URL(storeUrl).origin;
  } catch {
    halt("That does not look like a store address.");
    return;
  }

  Object.assign(state, {
    running: true,
    stopped: false,
    store: storeUrl,
    phase: "planning",
    message: "",
    planned: 0,
    done: 0,
    imported: 0,
    failed: 0,
    delayMs: MIN_DELAY_MS,
  });

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
      `The store refused the first page (HTTP ${first.status}). Nothing else was requested. Open it in a normal tab, clear whatever check it is showing, and try again.`,
    );
    return;
  }

  let html = first.html ?? "";
  let docs = [];
  const readDocs = new Set();
  const seen = [];
  let collected = 0;
  let refusals = 0;
  let sinceRest = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (state.stopped || collected >= limit) break;

    state.phase = "planning";
    state.message = "";
    const planned = await askPage("plan", {
      url: storeUrl,
      html,
      robotsTxt,
      sitemaps: docs,
      seen,
      limit: limit - collected,
    });
    html = ""; // the start page is only worth sending once

    if (!planned.ok) {
      halt(planned.error ?? "The collect tab could not plan the run.");
      return;
    }

    const plan = planned.data ?? {};
    const urls = Array.isArray(plan.urls) ? plan.urls : [];
    state.delayMs = Math.max(Number(plan.delayMs) || MIN_DELAY_MS, MIN_DELAY_MS);
    state.planned = collected + urls.length;
    pushProgress();

    state.phase = "collecting";

    for (const url of urls) {
      if (state.stopped || collected >= limit) break;
      seen.push(url);

      await politePause();
      if (state.stopped) break;

      const snap = await snapshotPage(url);

      if (snap.refused) {
        refusals++;
        state.failed++;
        if (refusals >= REFUSAL_LIMIT) {
          halt(
            `The store refused two pages in a row (HTTP ${snap.status}). The run stopped so your address does not end up blocked. Try again later, or more slowly.`,
          );
          return;
        }
        continue;
      }
      refusals = 0;

      if (!snap.html) {
        state.failed++;
        state.done = ++collected;
        continue;
      }

      const ingested = await askPage("ingest", {
        url,
        html: snap.html,
        images: snap.images,
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
      });
      collected++;
      state.done = collected;
      if (ingested.ok) state.imported++;
      else state.failed++;
      pushProgress();

      sinceRest++;
      if (sinceRest >= REST_EVERY && collected < limit && !state.stopped) {
        sinceRest = 0;
        state.message = "Resting so the store does not notice a rhythm…";
        await sleep(REST_MS);
        state.message = "";
      }
    }

    if (state.stopped || collected >= limit) break;

    // Sitemaps for the next round. The server names them; we fetch them.
    const next = (Array.isArray(plan.fetchNext) ? plan.fetchNext : []).filter(
      (u) => !readDocs.has(u),
    );
    if (!next.length) break;

    docs = [];
    for (const docUrl of next) {
      if (state.stopped) break;
      readDocs.add(docUrl);
      const xml = await fetchText(docUrl);
      if (xml) docs.push({ url: docUrl, xml });
      await sleep(SITEMAP_GAP_MS);
    }
    if (!docs.length) break;
  }

  finish();
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
      const limit = Math.max(1, Math.min(Number(msg.payload?.limit) || 30, 2_000));
      run({ storeUrl, limit }).catch((err) => {
        halt(err?.message ?? "The run failed unexpectedly.");
      });
      sendResponse({ ok: true });
      return undefined;
    }

    default:
      return undefined;
  }
});

// A collect tab that goes away should not be talked to.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.studioTabId) void rememberStudioTab(null);
});
