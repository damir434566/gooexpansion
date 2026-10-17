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
 *
 * "Collect the whole store" starts the same way and runs for days. Where it
 * got to is kept in `chrome.storage` (`siteRun`), so when the admin comes back
 * to the store after a Stop, a halt or a restart of Chrome, the popup offers
 * Resume.
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
  aiSkipped: document.getElementById("aiSkipped"),
  pace: document.getElementById("pace"),
  retry: document.getElementById("retry"),
  note: document.getElementById("note"),
  whole: document.getElementById("whole"),
  site: document.getElementById("site"),
  resume: document.getElementById("resume"),
  siteHint: document.getElementById("siteHint"),
  rule: document.getElementById("rule"),
  rows: document.getElementById("rows"),
  pageActions: document.getElementById("pageActions"),
  pick: document.getElementById("pick"),
  pickFound: document.getElementById("pickFound"),
  pickRule: document.getElementById("pickRule"),
  showTaking: document.getElementById("showTaking"),
  showSkipped: document.getElementById("showSkipped"),
  pickList: document.getElementById("pickList"),
  pickGo: document.getElementById("pickGo"),
  pickCancel: document.getElementById("pickCancel"),
  pickHint: document.getElementById("pickHint"),
};

const SITE_HINT = el.siteHint.textContent.replace(/\s+/g, " ").trim();

let activeUrl = "";
/** The tab the popup was opened over: the page the run walks. */
let activeTabId = null;
/** What the last run came to, for when the worker has gone to sleep since. */
let lastRun = null;
/** The last whole-store run, as far as it got: what Resume picks up. */
let savedSite = null;
/** Ticks changed in the list since the popup opened: a read begun before one is stale. */
let pickEdits = 0;

async function readSavedSite() {
  const edits = pickEdits;
  try {
    const { siteRun } = await chrome.storage.local.get("siteRun");
    if (edits !== pickEdits) return;
    savedSite = siteRun && typeof siteRun === "object" && Array.isArray(siteRun.categories) ? siteRun : null;
  } catch {
    savedSite = null;
  }
}

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

/**
 * "What to collect", the rule AI picks a whole-store run's categories by. Like
 * "Links only" it belongs to a store ("no kids" on one, "only shoes" on
 * another), so it is kept per store, for the 500 stores used last.
 */
const RULES_KEY = "categoryRules";

async function storeRules() {
  const stored = await chrome.storage.local.get(RULES_KEY);
  const rules = stored[RULES_KEY];
  return rules && typeof rules === "object" && !Array.isArray(rules) ? rules : {};
}

async function rememberRule(host, rule) {
  if (!host) return;
  const rules = await storeRules();
  delete rules[host];
  const text = String(rule || "").trim().slice(0, 500);
  if (text) rules[host] = text;
  const kept = Object.entries(rules).slice(-500);
  await chrome.storage.local.set({ [RULES_KEY]: Object.fromEntries(kept) });
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
  await readSavedSite();

  if (/^https?:/i.test(activeUrl)) {
    el.store.textContent = activeUrl.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70);
    el.linksOnly.checked = (await linksOnlyStores()).includes(hostOf(activeUrl));
    el.rule.value = (await storeRules())[hostOf(activeUrl)] || "";
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

/**
 * "Collect the whole store", or Resume. The same asking as `start`: the
 * store's permission under the click, the collect tab, then the worker takes
 * it from there. A resume goes back to the store the run was collecting, and
 * the worker opens it in a tab of its own if this one is elsewhere.
 */
async function startSite(resume) {
  note("");
  el.site.disabled = true;
  el.resume.disabled = true;
  const done = () => {
    el.site.disabled = !/^https?:/i.test(activeUrl);
    el.resume.disabled = false;
  };

  const storeUrl = resume && savedSite ? savedSite.store : activeUrl;
  let origin;
  try {
    origin = new URL(storeUrl).origin;
  } catch {
    note("This tab is not a store page.");
    done();
    return;
  }
  if (!resume && unfinished() && !window.confirm(
    "Start the whole store over? The run so far is forgotten, and every piece is opened again (pieces already in the catalogue are updated, not doubled). Resume carries on instead.",
  )) {
    done();
    return;
  }

  const studioOrigin = (el.studio.value || DEFAULT_STUDIO).replace(/\/+$/, "");
  const linksOnly = el.linksOnly.checked;
  const rule = el.rule.value.trim().slice(0, 500);
  await chrome.storage.sync.set({ studioOrigin });
  if (!resume) {
    await rememberLinksOnly(hostOf(storeUrl), linksOnly);
    await rememberRule(hostOf(storeUrl), rule);
  }

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch (err) {
    note(err?.message ?? "Could not ask for permission.");
    done();
    return;
  }
  if (!granted) {
    note("Without permission for this store the extension cannot read its pages.");
    done();
    return;
  }

  const link = await ensureCollectTab(studioOrigin);
  if (!link.ok) {
    note(
      link.error && /sign/i.test(link.error)
        ? link.error
        : `Could not reach ${studioOrigin}${COLLECT_PATH}. Open it, make sure you are signed in as an admin, reload it, then try again.`,
    );
    done();
    return;
  }

  // A resumed run keeps the categories its own rule chose.
  const res = await send("site", { storeUrl, linksOnly, tabId: activeTabId, resume, rule: resume ? "" : rule });
  if (res && res.ok === false) {
    note(res.error ?? "Could not start.");
    done();
    return;
  }
  done();
  render(await send("state"));
}

/** A whole-store run of this store that stopped before the end. */
function unfinished() {
  return !!savedSite && savedSite.stage !== "done" && hostOf(savedSite.store) === hostOf(activeUrl);
}

// ── AI's choice of categories, before a whole-store run walks ───────────────

const PICK_HINT =
  "Inside them AI checks every piece by its name before opening it, and the store's sitemaps go through the same check at the end.";
/** Which half of the list is shown: what AI took, or what it left out. */
let pickView = "taking";
/** The list as last drawn, so the poll does not redraw it under the admin's pointer. */
let pickKey = "";

/** A whole-store run of this store waiting for its categories to be confirmed. */
function picking(running) {
  return (
    !running &&
    !!savedSite &&
    savedSite.stage === "pick" &&
    Array.isArray(savedSite.pick) &&
    hostOf(savedSite.store) === hostOf(activeUrl)
  );
}

/** "/men/shoes/cat/?cid=4209" */
function pathOf(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function pickRow(item, index) {
  const row = document.createElement("label");
  row.className = item.keep ? "item" : "item off";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !!item.keep;
  box.dataset.index = String(index);
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = item.label || pathOf(item.url);
  const path = document.createElement("span");
  path.className = "path";
  path.textContent = pathOf(item.url);
  name.append(path);
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = item.mixed ? "mixed" : "";
  row.append(box, name, tag);
  return row;
}

/** The list, the counts on the chips and the button, and why AI could not choose. */
function renderPick() {
  const run = savedSite;
  const items = run.pick;
  const byAi = items.filter((p) => p.ai).length;
  const ticked = items.filter((p) => p.keep).length;
  const failed = !run.rule;
  el.pickFound.textContent = failed
    ? `All ${num(items.length)} of the menu's categories`
    : `AI picked ${num(byAi)} of the menu's ${num(items.length)} categories`;
  el.pickRule.textContent = run.askedRule ? `Rule: «${run.askedRule}»` : "";
  el.showTaking.textContent = `Taking ${num(byAi)}`;
  el.showSkipped.textContent = `Show skipped ${num(items.length - byAi)}`;
  el.showTaking.classList.toggle("on", pickView === "taking");
  el.showSkipped.classList.toggle("on", pickView === "skipped");
  el.showTaking.setAttribute("aria-pressed", String(pickView === "taking"));
  el.showSkipped.setAttribute("aria-pressed", String(pickView === "skipped"));
  el.pickGo.textContent = `Collect ${num(ticked)} ${ticked === 1 ? "category" : "categories"}`;
  el.pickGo.disabled = !ticked;

  const changed = items.filter((p) => !!p.keep !== !!p.ai);
  el.pickHint.textContent = !changed.length
    ? PICK_HINT
    : changed.length === 1
      ? `You ${changed[0].keep ? "ticked" : "unticked"} ${changed[0].label || pathOf(changed[0].url)} yourself: ${num(ticked)} ${
          ticked === 1 ? "category" : "categories"
        } now.`
      : `You changed ${changed.length} of AI's choices: ${num(ticked)} ${ticked === 1 ? "category" : "categories"} now.`;

  const shown = items.map((p, i) => [p, i]).filter(([p]) => (pickView === "taking" ? p.ai : !p.ai));
  const key = JSON.stringify([pickView, shown.map(([p, i]) => [i, !!p.keep])]);
  if (key !== pickKey) {
    pickKey = key;
    if (shown.length) el.pickList.replaceChildren(...shown.map(([p, i]) => pickRow(p, i)));
    else {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = pickView === "taking" ? "AI took none of them." : "AI left none out.";
      el.pickList.replaceChildren(empty);
    }
  }

  note(
    failed
      ? `AI could not choose (${run.aiWhy || "it did not answer"}). Every category is ticked and pieces will not be checked by name. Untick what you don't want, or Cancel and fix the cause.`
      : "",
  );
}

/** The popup while a run waits on the list: only the list and its two buttons. */
function showPick(on) {
  el.pick.hidden = !on;
  el.rows.hidden = on;
  el.pageActions.hidden = on;
  if (on) {
    el.whole.hidden = true;
    el.progress.hidden = true;
  }
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

/** "3,412" */
function num(n) {
  return Number(n || 0).toLocaleString("en-US");
}

/** "AI skipped 3,417 pieces that don't fit the rule", the number in bold. */
function showAiSkipped(site) {
  const n = site ? site.aiSkipped || 0 : 0;
  el.aiSkipped.hidden = !n;
  if (!n) return;
  const count = document.createElement("b");
  count.textContent = num(n);
  el.aiSkipped.replaceChildren("AI skipped ", count, ` ${n === 1 ? "piece that doesn't" : "pieces that don't"} fit the rule`);
}

/** Why AI is not choosing for the run: the month's limit, an error. Said where it cannot be missed. */
function siteWarning(site) {
  if (site.aiWarn) return site.aiWarn;
  // The rule was not applied to the categories.
  return site.aiFailed && site.ai ? site.ai : "";
}

/** Where a whole-store run is, in a line. */
function siteWhere(site) {
  if (site.stage === "menu") return "Whole store: reading the store's menu…";
  if (site.stage === "categories") {
    return `Category ${site.index + 1} of ${site.categories}${site.skipped ? ` (AI left out ${site.skipped})` : ""}: ${site.label}`;
  }
  if (site.stage === "sitemaps") {
    return `Sitemaps, for pieces no category showed: ${num(site.sitemapsRead)} read${
      site.sitemapsQueued ? `, ${num(site.sitemapsQueued)} to go` : ""
    }`;
  }
  if (site.ai && !site.aiFailed) {
    return `Whole store: the ${num(site.categories)} categories AI chose${site.skipped ? ` (${num(site.skipped)} left out)` : ""}`;
  }
  return `Whole store: all ${num(site.categories)} categories and ${num(site.sitemapsRead)} sitemaps`;
}

/** How far along a whole-store run is, roughly: categories first, then sitemaps. */
function sitePercent(site) {
  if (site.stage === "categories" && site.categories) return Math.round((site.index / site.categories) * 90);
  if (site.stage === "sitemaps") {
    const all = (site.sitemapsRead || 0) + (site.sitemapsQueued || 0);
    return 90 + (all ? Math.round((site.sitemapsRead / all) * 10) : 0);
  }
  return site.stage === "done" ? 100 : 2;
}

/** "about 900 pieces an hour", once there is enough of the run to say. */
function siteRate(shown) {
  const s = shown.site;
  const hours = (Date.now() - (s.resumedAt || Date.now())) / 3_600_000;
  const n = (shown.done || 0) - (s.doneAtResume || 0);
  if (hours < 0.03 || n < 5) return "";
  return `about ${num(Math.round(n / hours))} pieces an hour`;
}

/** The Resume button and the hint under the whole-store row. */
function showResume(running) {
  el.whole.hidden = running;
  el.site.disabled = running || !/^https?:/i.test(activeUrl);
  const can = !running && unfinished();
  el.resume.hidden = !can;
  el.site.textContent = can ? "Start over" : "Collect the whole store";
  if (can) {
    const s = savedSite;
    const where =
      s.stage === "sitemaps"
        ? "at the sitemaps"
        : `at category ${Math.min(s.index + 1, s.categories.length)} of ${s.categories.length}`;
    el.resume.textContent = "Resume";
    el.siteHint.textContent = `The last whole-store run ${s.status === "halted" ? "halted" : "stopped"} ${where}, ${num(
      s.done,
    )} pieces in. Resume carries on from there; nothing it opened is opened again.`;
  } else {
    el.siteHint.textContent = SITE_HINT;
  }
}

function render(state) {
  if (!state) return;

  const running = state.running && !state.stopped;
  el.start.hidden = running;
  el.stop.hidden = !running;
  el.start.disabled = running || !/^https?:/i.test(activeUrl);
  showResume(running);
  const pickNow = picking(running);
  showPick(pickNow);
  if (pickNow) {
    renderPick();
    return;
  }

  // A worker that has slept since its last run remembers nothing; what that
  // run came to was kept for exactly this.
  const ended = !running && ["done", "stopped", "halted"].includes(state.phase);
  const remembered = lastRun && state.phase === "idle" && hostOf(lastRun.store) === hostOf(activeUrl) ? lastRun : null;
  const shown = running || ended ? state : remembered;
  el.progress.hidden = !shown;
  if (!shown) return;

  const listing = running && shown.phase === "listing";
  showAiSkipped(shown.site);
  if (shown.site) {
    renderSite(shown, running, listing);
    finishRender(shown, running);
    const warning = siteWarning(shown.site);
    if (warning && (running || shown.phase === "done")) note(warning);
    return;
  }
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
  finishRender(shown, running);
}

/** A whole-store run: where it is in the store, and what it has come to. */
function renderSite(shown, running, listing) {
  el.fill.style.width = `${sitePercent(shown.site)}%`;
  el.found.hidden = false;
  el.found.textContent = siteWhere(shown.site);
  el.done.textContent = num(shown.done);
  el.planned.textContent = shown.done === 1 ? "piece" : "pieces";
  showCounts(shown.counts);
  if (running) {
    const pace = listing
      ? `Walking the category${shown.listing && shown.listing.pages > 1 ? `, page ${shown.listing.pages}` : ""}. Keep the store tab in front.`
      : `One page every ${((shown.delayMs || 1500) / 1000).toFixed(1)}s or slower`;
    const rate = siteRate(shown);
    el.pace.textContent = shown.message || (rate ? `${pace} · ${rate}` : pace);
  } else {
    el.pace.textContent = shown.message && shown.phase !== "halted" ? shown.message : "";
  }
}

/** Retry and the note, for every kind of run. */
function finishRender(shown, running) {
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

el.rule.addEventListener("change", () => {
  rememberRule(hostOf(activeUrl), el.rule.value).catch(() => {});
});

el.stop.addEventListener("click", async () => {
  await send("stop");
  render(await send("state"));
});

el.all.addEventListener("change", showLimit);

el.site.addEventListener("click", () => {
  startSite(false).catch((err) => {
    note(err?.message ?? "Could not start.");
    el.site.disabled = false;
  });
});

el.resume.addEventListener("click", () => {
  startSite(true).catch((err) => {
    note(err?.message ?? "Could not resume.");
    el.resume.disabled = false;
  });
});

el.showTaking.addEventListener("click", () => {
  pickView = "taking";
  if (picking(false)) renderPick();
});

el.showSkipped.addEventListener("click", () => {
  pickView = "skipped";
  if (picking(false)) renderPick();
});

// A tick is kept as it is made: a popup closed and opened again finds it.
el.pickList.addEventListener("change", (event) => {
  const box = event.target;
  if (!(box instanceof HTMLInputElement) || !savedSite || !Array.isArray(savedSite.pick)) return;
  const item = savedSite.pick[Number(box.dataset.index)];
  if (!item) return;
  item.keep = box.checked;
  box.closest(".item")?.classList.toggle("off", !box.checked);
  pickEdits++;
  chrome.storage.local.set({ siteRun: savedSite }).catch(() => {});
  renderPick();
});

el.pickGo.addEventListener("click", () => {
  el.pickGo.disabled = true;
  startSite(true).catch((err) => {
    note(err?.message ?? "Could not start.");
    el.pickGo.disabled = false;
  });
});

el.pickCancel.addEventListener("click", async () => {
  el.pickCancel.disabled = true;
  await send("site-cancel");
  pickEdits++;
  savedSite = null;
  lastRun = null;
  pickKey = "";
  el.pickCancel.disabled = false;
  note("");
  render(await send("state"));
});

el.retry.addEventListener("click", async () => {
  note("");
  el.retry.disabled = true;
  const res = await send("retry");
  el.retry.disabled = false;
  if (res && res.ok === false) note(res.error ?? "Could not retry.");
  render(await send("state"));
});

// The popup is a window onto the worker, so it polls while it is open.
const poll = setInterval(async () => {
  await readSavedSite();
  render(await send("state"));
}, 700);
window.addEventListener("unload", () => clearInterval(poll));

init().catch((err) => note(err?.message ?? "Could not read this tab."));
