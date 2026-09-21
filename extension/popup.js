/**
 * The popup: pick a store, say how much, start, watch, stop.
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
  limit: document.getElementById("limit"),
  studio: document.getElementById("studio"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  progress: document.getElementById("progress"),
  fill: document.getElementById("fill"),
  done: document.getElementById("done"),
  planned: document.getElementById("planned"),
  imported: document.getElementById("imported"),
  failed: document.getElementById("failed"),
  pace: document.getElementById("pace"),
  note: document.getElementById("note"),
};

let activeUrl = "";

function note(message) {
  el.note.textContent = message ?? "";
  el.note.hidden = !message;
}

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload }).catch(() => null);
}

// ── Setup ────────────────────────────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.sync.get(["studioOrigin", "limit"]);
  el.studio.value = stored.studioOrigin || DEFAULT_STUDIO;
  if (stored.limit) el.limit.value = stored.limit;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeUrl = tab?.url ?? "";

  if (/^https?:/i.test(activeUrl)) {
    el.store.textContent = activeUrl.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70);
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
  const known = await send("state");
  if (known?.studioTabId != null) return true;

  await chrome.tabs.create({ url: `${studioOrigin}${COLLECT_PATH}`, active: false });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await send("state");
    if (s?.studioTabId != null) return true;
  }
  return false;
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
  const limit = Math.max(1, Math.min(Number(el.limit.value) || 30, 2000));
  await chrome.storage.sync.set({ studioOrigin, limit });

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

  if (!(await ensureCollectTab(studioOrigin))) {
    note(
      `Could not reach ${studioOrigin}${COLLECT_PATH}. Open it, make sure you are signed in as an admin, reload it, then try again.`,
    );
    el.start.disabled = false;
    return;
  }

  const res = await send("start", { storeUrl: activeUrl, limit });
  if (res && res.ok === false) {
    note(res.error ?? "Could not start.");
    el.start.disabled = false;
    return;
  }
  render(await send("state"));
}

// ── Display ──────────────────────────────────────────────────────────────────

function render(state) {
  if (!state) return;

  const running = state.running && !state.stopped;
  el.start.hidden = running;
  el.stop.hidden = !running;
  el.start.disabled = running || !/^https?:/i.test(activeUrl);

  const show = running || state.done > 0;
  el.progress.hidden = !show;

  if (show) {
    const pct = state.planned ? Math.min(100, Math.round((state.done / state.planned) * 100)) : 0;
    el.fill.style.width = `${state.phase === "planning" ? 4 : pct}%`;
    el.done.textContent = String(state.done);
    el.planned.textContent = state.planned ? `of ${state.planned}` : "";
    el.imported.textContent = state.imported ? `${state.imported} in` : "";
    el.failed.textContent = state.failed ? `${state.failed} skipped` : "";
    el.pace.textContent =
      state.message ||
      (running ? `One page every ${(state.delayMs / 1000).toFixed(1)}s or slower` : "");
  }

  if (state.phase === "halted" && state.message) note(state.message);
  else if (state.phase === "stopped") note("Stopped.");
  else if (state.phase === "done") note("");
}

// ── Wiring ───────────────────────────────────────────────────────────────────

el.start.addEventListener("click", () => {
  start().catch((err) => {
    note(err?.message ?? "Could not start.");
    el.start.disabled = false;
  });
});

el.stop.addEventListener("click", async () => {
  await send("stop");
  render(await send("state"));
});

// The popup is a window onto the worker, so it polls while it is open.
const poll = setInterval(async () => render(await send("state")), 700);
window.addEventListener("unload", () => clearInterval(poll));

init().catch((err) => note(err?.message ?? "Could not read this tab."));
