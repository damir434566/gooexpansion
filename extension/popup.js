/**
 * The popup: the page to collect, how much of it, start, watch, stop, retry.
 *
 * Two things have to happen here rather than in the worker, and both are
 * because Chrome requires them to happen under a click:
 *
 *   1. Asking for permission to read this store. The extension ships with none
 *      — `optional_host_permissions` rather than `<all_urls>` — so installing
 *      it grants access to nothing, and each store is granted by the admin,
 *      once, on the store they are actually looking at. `permissions.request`
 *      is only honoured during a user gesture.
 *   2. Opening the collect tab if it is not already there.
 *
 * Everything after that belongs to the worker, which survives this popup being
 * closed — as it will be, since a run takes minutes.
 */

const DEFAULT_STUDIO = "https://www.goo-fashion.com";
const COLLECT_PATH = "/goo-studio/parser/collect";

const el = {
  store: document.getElementById("store"),
  all: document.getElementById("all"),
  limitRow: document.getElementById("limitRow"),
  limit: document.getElementById("limit"),
  linksOnly: document.getElementById("linksOnly"),
  studio: document.getElementById("studio"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  progress: document.getElementById("progress"),
  fill: document.getElementById("fill"),
  found: document.getElementById("found"),
  done: document.getElementById("done"),
  planned: document.getElementById("planned"),
  added: document.getElementById("new"),
  updated: document.getElementById("updated"),
  skipped: document.getElementById("skipped"),
  failed: document.getElementById("failed"),
  pace: document.getElementById("pace"),
  retry: document.getElementById("retry"),
  note: document.getElementById("note"),
};

let activeUrl = "";
/** The tab the popup was opened over: the page the run walks. */
let activeTabId = null;
/** What the last run came to, for when the worker has gone to sleep since. */
let lastRun = null;

/**
 * "Links only" is a fact about a store, not about a run: a store whose cards
 * we already have from elsewhere will be a links store next week too. So it is
 * remembered per store (its host, without `www.`), on this machine, and the
 * box is ticked again when the admin comes back to it. The key is 1.0.5's, so
 * stores ticked then come back ticked.
 */
const LINK_ONLY_KEY = "linkOnlyStores";

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function linksOnlyStores() {
  const stored = await chrome.storage.local.get(LINK_ONLY_KEY);
  return Array.isArray(stored[LINK_ONLY_KEY]) ? stored[LINK_ONLY_KEY] : [];
}

async function rememberLinksOnly(host, on) {
  if (!host) return;
  const list = (await linksOnlyStores()).filter((h) => h !== host);
  if (on) list.push(host);
  await chrome.storage.local.set({ [LINK_ONLY_KEY]: list.slice(-500) });
}

function note(message) {
  el.note.textContent = message ?? "";
  el.note.hidden = !message;
}

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload }).catch(() => null);
}

// ── Setup ────────────────────────────────────────────────────────────────────

/** "Everything on this page" makes the number beside it moot. */
function showLimit() {
  el.limit.disabled = el.all.checked;
  el.limitRow.classList.toggle("off", el.all.checked);
}

async function init() {
  const stored = await chrome.storage.sync.get(["studioOrigin", "limit", "collectAll"]);
  el.studio.value = stored.studioOrigin || DEFAULT_STUDIO;
  if (stored.limit) el.limit.value = stored.limit;
  el.all.checked = stored.collectAll !== false;
  showLimit();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeUrl = tab?.url ?? "";
  activeTabId = Number.isInteger(tab?.id) ? tab.id : null;
  try {
    const { lastRun: last } = await chrome.storage.local.get("lastRun");
    lastRun = last && typeof last === "object" ? last : null;
  } catch {
    lastRun = null;
  }

  if (/^https?:/i.test(activeUrl)) {
    el.store.textContent = activeUrl.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70);
    el.linksOnly.checked = (await linksOnlyStores()).includes(hostOf(activeUrl));
  } else {
    el.store.textContent = "Open a store page in this tab first.";
    el.start.disabled = true;
  }

  render(await send("state"));
}

// ── Starting ─────────────────────────────────────────────────────────────────

/**
 * The collect tab, opened if needed.
 *
 * The worker learns which tab it is when the bridge content script announces
 * itself, so after opening one we wait for that to happen rather than assuming
 * it has. A tab that was already open before the extension was installed has no
 * content script in it until it is reloaded — hence the honest timeout message.
 */
async function ensureCollectTab(studioOrigin) {
  // A tab id alone proves nothing: the tab may have reloaded, been sent to
  // sign in, or kept a bridge from before an update. Ask the worker to reach it.
  const first = await send("connect");
  if (first?.ok) return { ok: true };

  await chrome.tabs.create({ url: `${studioOrigin}${COLLECT_PATH}`, active: false });

  let last = first;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await send("state");
    if (s?.studioTabId == null) continue;
    last = await send("connect");
    if (last?.ok) return { ok: true };
  }
  return { ok: false, error: last?.error };
}

async function start() {
  note("");
  el.start.disabled = true;

  let origin;
  try {
    origin = new URL(activeUrl).origin;
  } catch {
    note("This tab is not a store page.");
    el.start.disabled = false;
    return;
  }

  const studioOrigin = (el.studio.value || DEFAULT_STUDIO).replace(/\/+$/, "");
  const collectAll = el.all.checked;
  const typed = Math.max(1, Math.min(Number(el.limit.value) || 30, 2000));
  // "Everything" means everything this page shows, which only a walk of the
  // tab can find. Without a tab to walk, the run falls back to the address and
  // the store's sitemaps, and there "everything" would be the whole store.
  const limit = collectAll && activeTabId != null ? 2000 : typed;
  const linksOnly = el.linksOnly.checked;
  await chrome.storage.sync.set({ studioOrigin, limit: typed, collectAll });
  await rememberLinksOnly(hostOf(activeUrl), linksOnly);

  // Must be inside the click: Chrome refuses a permission prompt without one.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch (err) {
    note(err?.message ?? "Could not ask for permission.");
    el.start.disabled = false;
    return;
  }
  if (!granted) {
    note("Without permission for this store the extension cannot read its pages.");
    el.start.disabled = false;
    return;
  }

  const link = await ensureCollectTab(studioOrigin);
  if (!link.ok) {
    note(
      link.error && /sign/i.test(link.error)
        ? link.error
        : `Could not reach ${studioOrigin}${COLLECT_PATH}. Open it, make sure you are signed in as an admin, reload it, then try again.`,
    );
    el.start.disabled = false;
    return;
  }

  // The tab goes with the address: the worker walks this very page, in front,
  // where the store loads the rest of its grid as it is scrolled.
  const res = await send("start", { storeUrl: activeUrl, limit, linksOnly, tabId: activeTabId });
  if (res && res.ok === false) {
    note(res.error ?? "Could not start.");
    el.start.disabled = false;
    return;
  }
  render(await send("state"));
}

// ── Display ──────────────────────────────────────────────────────────────────

/** "214", or "at least 214" when a run that asked for a few stopped looking early. */
function foundText(found, atLeast) {
  return `Found ${atLeast ? "at least " : ""}${found} piece${found === 1 ? "" : "s"} on the page`;
}

function showCounts(counts) {
  const c = counts || {};
  el.added.textContent = c.new ? `${c.new} new` : "";
  el.updated.textContent = c.updated ? `${c.updated} updated` : "";
  el.skipped.textContent = c.skipped ? `${c.skipped} skipped` : "";
  el.failed.textContent = c.failed ? `${c.failed} failed` : "";
}

function render(state) {
  if (!state) return;

  const running = state.running && !state.stopped;
  el.start.hidden = running;
  el.stop.hidden = !running;
  el.start.disabled = running || !/^https?:/i.test(activeUrl);

  // A worker that has slept since its last run remembers nothing; what that
  // run came to was kept for exactly this.
  const ended = !running && ["done", "stopped", "halted"].includes(state.phase);
  const remembered = lastRun && state.phase === "idle" && hostOf(lastRun.store) === hostOf(activeUrl) ? lastRun : null;
  const shown = running || ended ? state : remembered;
  el.progress.hidden = !shown;
  if (!shown) return;

  const listing = running && shown.phase === "listing";
  const pct = shown.planned ? Math.min(100, Math.round((shown.done / shown.planned) * 100)) : 0;
  el.fill.style.width = `${listing || shown.phase === "planning" ? 4 : pct}%`;

  el.found.hidden = !shown.found;
  if (shown.found) {
    el.found.textContent =
      foundText(shown.found, shown.foundAtLeast) +
      (shown.planned && shown.planned < shown.found ? ` · collecting the first ${shown.planned}` : "");
  }

  el.done.textContent = listing ? "" : String(shown.done || 0);
  el.planned.textContent = !listing && shown.planned ? `of ${shown.planned}` : "";
  showCounts(shown.counts);

  if (listing) {
    const l = shown.listing || { pages: 1, links: 0 };
    el.pace.textContent =
      shown.message ||
      `Scrolling the page${l.pages > 1 ? `, page ${l.pages}` : ""}… ${l.links} links so far. Keep the store tab in front.`;
  } else if (running) {
    el.pace.textContent =
      shown.message ||
      (shown.phase === "planning"
        ? "Planning…"
        : `One page every ${((shown.delayMs || 1500) / 1000).toFixed(1)}s or slower`);
  } else {
    el.pace.textContent = shown.message && shown.phase !== "halted" ? shown.message : "";
  }

  const failed = shown.counts?.failed || 0;
  el.retry.hidden = running || !failed;
  el.retry.textContent = `Retry ${failed} failed`;

  if (shown.phase === "halted" && shown.message) note(shown.message);
  else if (shown.phase === "stopped") note("Stopped.");
  else if (shown.phase === "done") note("");
}

// ── Wiring ───────────────────────────────────────────────────────────────────

el.start.addEventListener("click", () => {
  start().catch((err) => {
    note(err?.message ?? "Could not start.");
    el.start.disabled = false;
  });
});

// Remembered as soon as it is ticked, not only when a run starts.
el.linksOnly.addEventListener("change", () => {
  rememberLinksOnly(hostOf(activeUrl), el.linksOnly.checked).catch(() => {});
});

el.stop.addEventListener("click", async () => {
  await send("stop");
  render(await send("state"));
});

el.all.addEventListener("change", showLimit);

el.retry.addEventListener("click", async () => {
  note("");
  el.retry.disabled = true;
  const res = await send("retry");
  el.retry.disabled = false;
  if (res && res.ok === false) note(res.error ?? "Could not retry.");
  render(await send("state"));
});

// The popup is a window onto the worker, so it polls while it is open.
const poll = setInterval(async () => render(await send("state")), 700);
window.addEventListener("unload", () => clearInterval(poll));

init().catch((err) => note(err?.message ?? "Could not read this tab."));
