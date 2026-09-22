/**
 * Drives the real extension in real Chromium against the fixture store.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// Both paths are overridable, so this runs on a machine other than the one it
// was written on: CHROME_PATH for a local Chrome or Chromium, EXT_PATH if the
// extension under test lives somewhere other than this repository's copy.
const CHROME =
  process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXT = process.env.EXT_PATH || path.join(__dirname, "..", "extension");
const PROFILE = path.join(__dirname, "profile");
const PORT = 9333;
const STORE = "http://127.0.0.1:3301";
const STUDIO = "http://localhost:3302";
const COLLECT = `${STUDIO}/goo-studio/parser/collect`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── tiny CDP client ──────────────────────────────────────────────────────────

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return res.json();
}

async function waitForDevtools(timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return true;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("devtools never came up");
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 180000);
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? "evaluate threw");
    }
    return r.result.value;
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  });
  return new Session(ws);
}

async function newTab(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  return res.json();
}

// ── chrome lifecycle ─────────────────────────────────────────────────────────

let chrome = null;

function launch() {
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  chrome.stderr.on("data", () => {});
  return waitForDevtools();
}

async function shutdown() {
  if (!chrome) return;
  chrome.kill("SIGTERM");
  await sleep(1500);
  try { chrome.kill("SIGKILL"); } catch { /* already gone */ }
  chrome = null;
}

function prefsPath() {
  return path.join(PROFILE, "Default", "Preferences");
}

function findExtensionId() {
  const prefs = JSON.parse(fs.readFileSync(prefsPath(), "utf8"));
  const settings = prefs.extensions?.settings ?? {};
  for (const [id, v] of Object.entries(settings)) {
    if (typeof v.path === "string" && v.path === EXT) return id;
  }
  return null;
}

/**
 * Pre-grant the store origin.
 *
 * chrome.permissions.request needs a user gesture in a popup, which headless
 * automation cannot produce. Seeding the grant tests everything AFTER the
 * prompt — which is all of the run. That the extension asks for nothing at
 * install is asserted separately, from this same file, before this runs.
 */
function grantHost(id, pattern) {
  const p = prefsPath();
  const prefs = JSON.parse(fs.readFileSync(p, "utf8"));
  const entry = prefs.extensions.settings[id];
  for (const key of ["granted_permissions", "active_permissions"]) {
    entry[key] = entry[key] || { api: [], explicit_host: [], manifest_permissions: [], scriptable_host: [] };
    entry[key].explicit_host = [pattern];
    entry[key].scriptable_host = [pattern];
  }
  fs.writeFileSync(p, JSON.stringify(prefs));
}

function installedHostPermissions(id) {
  const prefs = JSON.parse(fs.readFileSync(prefsPath(), "utf8"));
  const e = prefs.extensions.settings[id];
  return {
    explicit: e.active_permissions?.explicit_host ?? [],
    scriptable: e.active_permissions?.scriptable_host ?? [],
    api: e.active_permissions?.api ?? [],
  };
}

// ── assertions ───────────────────────────────────────────────────────────────

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function storeControl(body) {
  await fetch(`${STORE}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const storeLog = () => fetch(`${STORE}/__log`).then((r) => r.json());
const studioEvents = () => fetch(`${STUDIO}/__events`).then((r) => r.json());
const studioReset = () => fetch(`${STUDIO}/__reset`, { method: "POST" });

async function openPopup(extId) {
  const t = await newTab(`chrome-extension://${extId}/popup.html`);
  await sleep(600);
  return attach(t.webSocketDebuggerUrl);
}

async function openCollect() {
  const t = await newTab(COLLECT);
  await sleep(1200);
  return attach(t.webSocketDebuggerUrl);
}

async function waitForEvent(kind, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { events } = await studioEvents();
    const hit = events.find((e) => e.kind === kind);
    if (hit) return hit;
    await sleep(500);
  }
  return null;
}

// ── the runs ─────────────────────────────────────────────────────────────────

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });

  console.log("\n— launching chromium with the unpacked extension —");
  await launch();
  await sleep(3000);
  // Chrome flushes Preferences on exit, so the install is inspected after a
  // clean shutdown rather than guessed at while it is running.
  await shutdown();
  for (let i = 0; i < 40 && !fs.existsSync(prefsPath()); i++) await sleep(250);
  if (!fs.existsSync(prefsPath())) throw new Error("chrome never wrote Preferences");

  const extId = findExtensionId();
  if (!extId) throw new Error("extension did not install");
  console.log(`  extension id ${extId}`);

  // The security property: nothing granted at install.
  const atInstall = installedHostPermissions(extId);
  check(
    "installs with access to no store whatsoever (no <all_urls>)",
    atInstall.explicit.length === 0,
    JSON.stringify(atInstall.explicit),
  );
  check(
    "the only pages it may touch at install are our own collect screen",
    atInstall.scriptable.length === 4 &&
      atInstall.scriptable.every((p) => p.endsWith("/goo-studio/parser/collect*")),
    JSON.stringify(atInstall.scriptable),
  );
  check("asks only for the four narrow APIs", JSON.stringify(atInstall.api.sort()) === JSON.stringify(["activeTab","scripting","storage","webRequest"]), JSON.stringify(atInstall.api));

  grantHost(extId, "http://127.0.0.1/*");
  await launch();
  await sleep(2500);
  console.log("  store origin granted (stands in for the popup prompt)\n");

  // ── Run A: a normal store ─────────────────────────────────────────────────
  console.log("— run A: ordinary store, Crawl-delay 2, one path disallowed —");
  await storeControl({ mode: "normal", reset: true });
  await studioReset();

  let collect = await openCollect();
  let popup = await openPopup(extId);

  const hasPerm = await popup.evaluate(
    `chrome.permissions.contains({origins:['${STORE}/*']})`,
  );
  check("the store origin is granted before the run", hasPerm === true, String(hasPerm));

  await popup.evaluate(
    `chrome.runtime.sendMessage({type:'start',payload:{storeUrl:'${STORE}/collections/all',limit:10}})`,
  );

  const doneA = await waitForEvent("done", 120000);
  check("run A finished", !!doneA);

  let { events } = await studioEvents();
  let log = (await storeLog()).log;

  const ingests = events.filter((e) => e.kind === "ingest");
  const planned = events.filter((e) => e.kind === "plan");

  check("the page said hello", events.some((e) => e.kind === "hello"));
  check("the server planned the run", planned.length > 0);
  check(
    "robots.txt was fetched before anything else",
    log.length > 0 && log[0].path === "/robots.txt",
    log[0] && log[0].path,
  );
  check("the sitemap was read", log.some((l) => l.path === "/sitemap.xml"));
  check("four products were imported", ingests.length === 4, `got ${ingests.length}`);

  const disallowedOpened = log.filter((l) => l.path.startsWith("/product/secret-"));
  check(
    "the robots-disallowed product was never opened",
    disallowedOpened.length === 0,
    JSON.stringify(disallowedOpened),
  );
  check(
    "and the plan reported it as blocked",
    planned.some((p) => p.detail.blocked >= 1),
    JSON.stringify(planned.map((p) => p.detail.blocked)),
  );
  check(
    "the pace came from the store's Crawl-delay, not our floor",
    planned[0]?.detail.delayMs === 2000,
    String(planned[0]?.detail.delayMs),
  );

  // Pacing between the product page loads.
  const productHits = log.filter((l) => l.path.startsWith("/product/")).map((l) => l.at);
  const gaps = productHits.slice(1).map((t, i) => t - productHits[i]);
  check(
    "every gap between product pages was at least the 2s the store asked for",
    gaps.every((g) => g >= 2000),
    JSON.stringify(gaps),
  );
  check("gaps varied — the rhythm is not machine-flat", new Set(gaps).size > 1, JSON.stringify(gaps));

  // The content script's work.
  const sizes = ingests.map((e) => e.detail.htmlLength);
  check("captured markup is well under the 3 MB cap", sizes.every((s) => s < 300_000), JSON.stringify(sizes));
  const { imported } = await studioEvents();
  check("the real extractor found a product in every capture", imported.length === 4, JSON.stringify(imported.map((i) => i.name)));
  check(
    "it read the name, brand and price from the captured DOM",
    imported.every((i) => /Fixture .* Coat/.test(i.name) && i.brand === "Fixture Atelier" && i.price === 249),
    JSON.stringify(imported[0]),
  );
  check(
    "the lazy gallery was woken by the scroll (2 real images, no data-URI)",
    imported.every((i) => i.images >= 2),
    JSON.stringify(imported.map((i) => i.images)),
  );

  collect.close(); popup.close();

  // ── Run B: the store refuses ──────────────────────────────────────────────
  console.log("\n— run B: the store answers 403 —");
  await storeControl({ mode: "refuse", reset: true });
  await studioReset();
  collect = await openCollect();
  popup = await openPopup(extId);

  await popup.evaluate(
    `chrome.runtime.sendMessage({type:'start',payload:{storeUrl:'${STORE}/collections/all',limit:10}})`,
  );

  const errB = await waitForEvent("error", 120000);
  check("the run halted and said why", !!errB, errB && errB.detail.message);
  check(
    "it named the refusal",
    !!errB && /refused/i.test(errB.detail.message ?? ""),
    errB && errB.detail.message,
  );

  log = (await storeLog()).log;
  const refusedHits = log.filter((l) => l.path.startsWith("/product/"));
  check(
    "it stopped after exactly two refusals, not more",
    refusedHits.length === 2,
    `opened ${refusedHits.length} product pages`,
  );

  collect.close(); popup.close();

  // ── Run C: Stop ───────────────────────────────────────────────────────────
  console.log("\n— run C: Stop mid-run —");
  await storeControl({ mode: "many", reset: true });
  await studioReset();
  collect = await openCollect();
  popup = await openPopup(extId);

  await popup.evaluate(
    `chrome.runtime.sendMessage({type:'start',payload:{storeUrl:'${STORE}/collections/all',limit:21}})`,
  );

  // Let it get going, then press Stop the way the screen does.
  await waitForEvent("ingest", 60000);
  await sleep(1200);
  await collect.evaluate("window.__gooStop()");
  const stoppedAt = Date.now();

  await sleep(9000);
  const afterStop = (await studioEvents()).events.filter(
    (e) => e.kind === "ingest" && e.at > stoppedAt + 1500,
  );
  check("nothing was imported after Stop", afterStop.length === 0, JSON.stringify(afterStop.map((e) => e.detail.url)));

  const logC = (await storeLog()).log;
  const lastHit = Math.max(...logC.map((l) => l.at));
  check(
    "the store stopped being asked for pages",
    lastHit < stoppedAt + 4000,
    `last request ${lastHit - stoppedAt}ms after Stop`,
  );

  collect.close(); popup.close();

  // ── Run D: the rest every 20 pages ────────────────────────────────────────
  console.log("\n— run D: 21 products, to catch the rest —");
  await storeControl({ mode: "many", reset: true });
  await studioReset();
  collect = await openCollect();
  popup = await openPopup(extId);

  await popup.evaluate(
    `chrome.runtime.sendMessage({type:'start',payload:{storeUrl:'${STORE}/collections/all',limit:21}})`,
  );
  const doneD = await waitForEvent("done", 300000);
  check("run D finished", !!doneD);

  const logD = (await storeLog()).log;
  const hitsD = logD.filter((l) => l.path.startsWith("/product/")).map((l) => l.at);
  const gapsD = hitsD.slice(1).map((t, i) => t - hitsD[i]);
  check(
    "with no Crawl-delay the 1.5s floor was applied",
    gapsD.length > 0 && gapsD.every((g) => g >= 1500),
    JSON.stringify(gapsD.slice(0, 5)),
  );
  const restGap = gapsD[19];
  check(
    "a ~10s rest landed after the 20th page",
    typeof restGap === "number" && restGap >= 11000,
    `gap after page 20 was ${restGap}ms`,
  );

  collect.close(); popup.close();

  // ── Run E: the gallery in the payload, the currency in the text ───────────
  //
  // The two cases this round was asked about. One page keeps its gallery in a
  // hydration payload, the way Farfetch does, and the content script deletes
  // that payload before sending — so before this change the product arrived
  // with the photos its carousel had mounted and nothing else. The other prices
  // in hryvnia and states that nowhere but in rendered text.
  console.log("\n— run E: a single-page storefront, and a store priced in hryvnia —");
  await storeControl({ mode: "spa", reset: true });
  await studioReset();
  collect = await openCollect();
  popup = await openPopup(extId);

  await popup.evaluate(
    `chrome.runtime.sendMessage({type:'start',payload:{storeUrl:'${STORE}/collections/all',limit:5}})`,
  );
  const doneE = await waitForEvent("done", 180000);
  check("run E finished", !!doneE);

  const eventsE = (await studioEvents()).events;
  const ingestsE = eventsE.filter((e) => e.kind === "ingest");
  const importedE = (await studioEvents()).imported;

  check("both pages were collected", ingestsE.length === 2, `got ${ingestsE.length}`);
  check(
    "the payload itself was NOT sent — the strip still runs",
    ingestsE.every((e) => e.detail.carriesPayload === false),
    JSON.stringify(ingestsE.map((e) => e.detail.carriesPayload)),
  );
  check(
    "captured markup stays small",
    ingestsE.every((e) => e.detail.htmlLength < 300_000),
    JSON.stringify(ingestsE.map((e) => e.detail.htmlLength)),
  );

  const bomber = importedE.find((i) => /Wool-blend bomber/.test(i.name || ""));
  check("the single-page product was read", !!bomber, JSON.stringify(importedE.map((i) => i.name)));
  check(
    "the extension handed over the photos it found before stripping",
    !!bomber && bomber.candidates >= 7,
    bomber && `candidates: ${bomber.candidates}`,
  );
  check(
    "all seven photos were imported, not the two the carousel had mounted",
    !!bomber && bomber.images === 7,
    bomber && `${bomber.images}: ${JSON.stringify(bomber.imageList)}`,
  );
  check(
    "the recommendations rail stayed out of the product",
    !!bomber && !bomber.imageList.some((u) => u.includes("31224455")),
    bomber && JSON.stringify(bomber.imageList.filter((u) => u.includes("31224455"))),
  );
  check(
    "the euro price was converted to dollars at the test's rate",
    !!bomber && bomber.currency === "EUR" && bomber.price === 1290 && bomber.usd === 1517.65,
    bomber && JSON.stringify({ price: bomber.price, currency: bomber.currency, usd: bomber.usd }),
  );

  const uah = importedE.find((i) => /Куртка/.test(i.name || ""));
  check("the hryvnia product was read", !!uah, JSON.stringify(importedE.map((i) => i.name)));
  check(
    "its currency came from the rendered text, which is the only place it exists",
    !!uah && uah.priceText === "4 000 ₴" && uah.currency === "UAH",
    uah && JSON.stringify({ priceText: uah.priceText, currency: uah.currency }),
  );
  check(
    "₴4,000 became $97.56 rather than $4,000",
    !!uah && uah.price === 4000 && uah.usd === 97.56 && uah.fxRate === 41,
    uah && JSON.stringify({ price: uah.price, usd: uah.usd, fxRate: uah.fxRate }),
  );
  check(
    "and nothing was filed as an unstated currency",
    !!uah && !(uah.issues || []).includes("currency not stated"),
    uah && JSON.stringify(uah.issues),
  );

  // Sizes. On the single-page product they exist only as buttons — the field
  // the parser had no source for at all. On the hryvnia page they are in the
  // store's own structured data, which used to be read and thrown away.
  check(
    "the extension read the size buttons",
    !!bomber && bomber.sizeCandidates >= 5,
    bomber && `candidates: ${bomber.sizeCandidates}`,
  );
  check(
    "sizes off the control, with the placeholder and the size-guide link left out",
    !!bomber && JSON.stringify(bomber.sizes) === JSON.stringify(["XS", "S", "M", "L", "XL"]),
    bomber && JSON.stringify(bomber.sizes),
  );
  check(
    "sizes out of structured data, where the page has no control to read",
    !!uah && JSON.stringify(uah.sizes) === JSON.stringify(["44", "46"]),
    uah && JSON.stringify(uah.sizes),
  );

  // Colour and colourways. This page states its colour nowhere but in the
  // swatch a shopper has selected — no `color` in its structured data, as on
  // the site it stands for.
  check(
    "the colour came off the selected swatch",
    !!bomber && JSON.stringify(bomber.colors) === JSON.stringify(["Charcoal"]),
    bomber && JSON.stringify(bomber.colors),
  );
  check(
    "the other colourways were taken from the colour row's links",
    !!bomber &&
      bomber.variantUrls.length === 2 &&
      bomber.variantUrls.every((u) => /item-2853003[45]\.aspx$/.test(u)),
    bomber && JSON.stringify(bomber.variantUrls),
  );
  check(
    "and the care link that shares that row is not one of them",
    !!bomber && !bomber.variantUrls.some((u) => u.includes("/care")),
    bomber && JSON.stringify(bomber.variantUrls),
  );

  // Description and material. The description is collapsed behind an accordion
  // — in the DOM, invisible, and empty as far as `innerText` is concerned — and
  // the composition is a definition list. Neither is in structured data.
  check(
    "the description was read out of a collapsed accordion",
    !!bomber && /Cut from a wool blend/.test(bomber.description || ""),
    bomber && JSON.stringify((bomber.description || "").slice(0, 80)),
  );
  check(
    "the extension read the spec rows",
    !!bomber && bomber.specCount >= 3,
    bomber && `specs: ${bomber.specCount}`,
  );
  check(
    "the material came off the spec table",
    !!bomber && bomber.material === "80% wool, 20% polyamide",
    bomber && JSON.stringify(bomber.material),
  );
  check(
    "and off a plain line of Ukrainian text on the other store",
    !!uah && uah.material === "95% бавовна, 5% еластан",
    uah && JSON.stringify(uah.material),
  );

  collect.close(); popup.close();

  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  failures.forEach((f) => console.log("  FAIL " + f));
  await shutdown();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error("\nDRIVER ERROR:", err.message);
  await shutdown();
  process.exit(2);
});
