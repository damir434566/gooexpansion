/**
 * The wire between the worker and the collect tab.
 *
 * The extension cannot call our admin API. The session is a Clerk cookie that
 * will not travel from a chrome-extension:// origin, and an API token baked
 * into an extension is a secret shipped to everyone who installs it. So the
 * worker asks this content script, this script asks the page it is running in,
 * and the page — already signed in as an admin — makes the call.
 *
 * Two hops, each one crossing a boundary the one before it cannot:
 *
 *   worker  --chrome.runtime-->  bridge  --window.postMessage-->  page
 *
 * The bridge also tells the worker which tab it is in. That is what lets the
 * whole extension work without the "tabs" permission: rather than querying
 * every tab for one whose URL looks like ours — which is a permission to read
 * the admin's browsing — the collect tab introduces itself.
 */

const FROM_EXT = "goo-collect/ext";
const FROM_PAGE = "goo-collect/page";

/**
 * The one page this bridge belongs on.
 *
 * `matches` in the manifest already narrows injection to this path, but the
 * guard is repeated here because the consequence of being wrong is specific:
 * the worker learns which tab to trust from whichever bridge announces itself
 * first, and a bridge running on some other page of the site would take that
 * place and send every API call somewhere that cannot answer it.
 */
const COLLECT_PATH = "/goo-studio/parser/collect";

/** How long to wait for the page before calling a request lost. */
const REPLY_TIMEOUT_MS = 120_000;

let nextId = 1;
/** id → resolver, for requests the page has not answered yet. */
const pending = new Map();

window.addEventListener("message", (event) => {
  // Same window, same origin, our marker. `postMessage` is shoutable by any
  // script on the page, and this bridge relays to a privileged worker.
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;

  const msg = event.data;
  if (!msg || msg.source !== FROM_PAGE) return;

  if (typeof msg.id === "number") {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    entry(msg.ok ? { ok: true, data: msg.data } : { ok: false, error: msg.error });
    return;
  }

  // One-way instructions from the screen. Stop is the one that matters, and it
  // has to reach the worker whatever it is in the middle of.
  if (msg.type === "stop") {
    chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});
  }
});

/** Ask the page something and wait for its answer. */
function ask(type, payload) {
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        resolve({ ok: false, error: "The collect tab did not answer in time" });
      }
    }, REPLY_TIMEOUT_MS);

    pending.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });

    window.postMessage({ source: FROM_EXT, id, type, payload: payload ?? {} }, window.location.origin);
  });
}

/** Tell the page something with no answer expected (progress, run finished). */
function tell(type, payload) {
  window.postMessage({ source: FROM_EXT, type, payload: payload ?? {} }, window.location.origin);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "bridge") return undefined;

  if (msg.type === "ping") {
    sendResponse({ ok: true });
    return undefined;
  }

  // Notices need no reply and must not hold the channel open.
  if (msg.type === "progress" || msg.type === "done" || msg.type === "error") {
    tell(msg.type, msg.payload);
    sendResponse({ ok: true });
    return undefined;
  }

  ask(msg.type, msg.payload).then(sendResponse);
  return true; // keep the channel open for the async reply
});

// Introduce this tab to the worker, and greet the page so it can show that the
// extension is connected rather than leaving the admin guessing.
if (window.location.pathname.startsWith(COLLECT_PATH)) {
  chrome.runtime.sendMessage({ type: "bridge-ready" }).catch(() => {});
  ask("hello", {});
}
