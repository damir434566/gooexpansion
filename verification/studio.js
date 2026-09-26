/**
 * A stand-in for Goo Studio, on an origin the extension's manifest matches.
 *
 * Two things are REAL here, and they are the two that matter:
 *   - /api/admin/parser/collect runs the actual planCollection from the repo
 *   - ingest runs the actual parsePage over whatever DOM the extension captured
 *
 * Only the two things this container cannot have are stubbed: Clerk's admin
 * session (no keys) and Supabase (no database), so importParsedProduct is
 * replaced by a recorder. Everything the extension touches, and everything that
 * decides what a product is, is the shipping code.
 *
 * The page itself implements the same postMessage protocol as
 * src/app/goo-studio/parser/collect/page.tsx, and records every message so the
 * test can assert on the conversation.
 */
const http = require("http");
const path = require("path");
const Module = require("module");

const COMPILED = path.join(__dirname, "compiled");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(COMPILED, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

const PARSER = path.join(COMPILED, "lib", "server", "parser");
const { planCollection } = require(path.join(PARSER, "plan-collection.js"));
const { parsePage } = require(path.join(PARSER, "parse-page.js"));
const { toUsd } = require(path.join(COMPILED, "lib", "server", "fx.js"));

/**
 * A rate provider that answers the same thing every time.
 *
 * The real one is an HTTP call to a third party, which this container cannot
 * make and a test should not depend on anyway: an assertion about a converted
 * price has to compare against a number the test chose. Only the rate endpoint
 * is intercepted — anything else that reaches `fetch` is a bug worth seeing.
 */
const FIXED_RATES = { EUR: 0.85, GBP: 0.74, UAH: 41, PLN: 3.6 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input && input.url;
  if (href && href.includes("open.er-api.com")) {
    return {
      ok: true,
      json: async () => ({
        result: "success",
        rates: FIXED_RATES,
        time_last_update_utc: "Mon, 21 Sep 2026 00:00:01 +0000",
      }),
    };
  }
  return realFetch(input, init);
};

const PORT = Number(process.env.STUDIO_PORT || 3302);
const HOST = "localhost";

const events = [];
const imported = [];

const FETCH_SETTINGS = {
  provider: "direct",
  endpoint: "",
  renderJs: false,
  impersonate: "chrome",
  timeoutMs: 15000,
};
const AI_SETTINGS = { enabled: false, mode: "auto", downloadImages: false };

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Collect</title></head>
<body>
<h1>Collect</h1><pre id="out"></pre>
<script>
const FROM_EXT = "goo-collect/ext";
const FROM_PAGE = "goo-collect/page";
let stopped = false;
const seen = [];

function log(kind, detail) {
  seen.push({ kind, detail, at: Date.now() });
  document.getElementById("out").textContent = seen.length + " messages";
  fetch("/__event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, detail, at: Date.now() }),
  }).catch(() => {});
}

function reply(id, ok, data) {
  if (typeof id !== "number") return;
  window.postMessage(
    Object.assign({ source: FROM_PAGE, id, ok }, ok ? { data } : { error: data }),
    window.location.origin
  );
}

async function callApi(payload) {
  const res = await fetch("/api/admin/parser/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const msg = event.data;
  if (!msg || msg.source !== FROM_EXT || typeof msg.type !== "string") return;
  const payload = msg.payload || {};

  if (msg.type === "hello") { log("hello", {}); return reply(msg.id, true, { ready: true }); }
  if (msg.type === "progress") { log("progress", payload); return; }
  if (msg.type === "done") { log("done", {}); return; }
  if (msg.type === "error") { log("error", payload); return; }

  if (msg.type === "plan") {
    if (stopped) return reply(msg.id, false, "Stopped by the admin");
    try {
      const data = await callApi(Object.assign({ action: "plan" }, payload));
      log("plan", { urls: data.urls, delayMs: data.delayMs, blocked: data.robots.blocked, fetchNext: data.fetchNext });
      reply(msg.id, true, data);
    } catch (e) { log("plan-error", { message: e.message }); reply(msg.id, false, e.message); }
    return;
  }

  if (msg.type === "ingest") {
    if (stopped) { log("ingest-refused", { url: payload.url }); return reply(msg.id, false, "Stopped by the admin"); }
    try {
      const data = await callApi(Object.assign({ action: "ingest" }, payload));
      log("ingest", {
        url: payload.url,
        htmlLength: (payload.html || "").length,
        candidates: Array.isArray(payload.images) ? payload.images.length : 0,
        linkOnly: payload.linkOnly === true,
        priceText: payload.priceText || "",
        // The strip has to still be doing its job: a payload that came back
        // whole would pass the photo assertions and blow the 3 MB cap.
        carriesPayload: /__NEXT_DATA__/.test(payload.html || ""),
        result: data.result,
      });
      reply(msg.id, true, data);
    } catch (e) { log("ingest-error", { url: payload.url, message: e.message }); reply(msg.id, false, e.message); }
    return;
  }
});

// Exposed so the test can press Stop the way the real screen does.
window.__gooStop = function () {
  stopped = true;
  log("stop-pressed", {});
  window.postMessage({ source: FROM_PAGE, type: "stop" }, window.location.origin);
};
</script>
</body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (p === "/goo-studio/parser/collect") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(PAGE);
  }

  if (p === "/__event" && req.method === "POST") {
    events.push(JSON.parse((await readBody(req)) || "{}"));
    return json(200, { ok: true });
  }

  if (p === "/__events") return json(200, { events, imported });

  if (p === "/__reset" && req.method === "POST") {
    events.length = 0;
    imported.length = 0;
    return json(200, { ok: true });
  }

  if (p === "/api/admin/parser/collect" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");

    if (body.action === "ingest") {
      try {
        // The real extractor, over the DOM the extension actually captured —
        // and over the evidence it read before stripping the page, exactly as
        // the shipping route passes it.
        const parsed = await parsePage(body.url, {
          fetchSettings: FETCH_SETTINGS,
          fetchApiKey: "",
          siteConfigs: [],
          aiSettings: AI_SETTINGS,
          useAi: false,
          html: body.html,
          evidence: {
            images: Array.isArray(body.images) ? body.images : [],
            priceText: typeof body.priceText === "string" ? body.priceText : "",
            sizes: Array.isArray(body.sizes) ? body.sizes : [],
            colorText: typeof body.colorText === "string" ? body.colorText : "",
            variantUrls: Array.isArray(body.variantUrls) ? body.variantUrls : [],
            descriptionText: typeof body.descriptionText === "string" ? body.descriptionText : "",
            specs: Array.isArray(body.specs) ? body.specs : [],
            breadcrumbs: Array.isArray(body.breadcrumbs) ? body.breadcrumbs : [],
            brandText: typeof body.brandText === "string" ? body.brandText : "",
          },
        });
        const product = parsed.products[0];
        if (!parsed.ok) return json(200, { ok: true, result: { url: body.url, status: "failed", reason: parsed.error } });
        if (!product || !product.name) {
          return json(200, { ok: true, result: { url: body.url, status: "skipped", reason: "No product data" } });
        }
        // importParsedProduct needs Supabase; do what it does to the price with
        // the real fx module, and record the rest instead of writing a row.
        const converted =
          product.price && product.currency && product.currency !== "USD"
            ? await toUsd(product.price, product.currency)
            : null;
        imported.push({
          url: body.url,
          name: product.name,
          brand: product.brand,
          price: product.price,
          currency: product.currency,
          usd: converted ? converted.usd : product.price,
          fxRate: converted ? converted.rate : null,
          issues: product.issues,
          images: product.images.length,
          imageList: product.images,
          sizes: product.sizes,
          colors: product.colors,
          variantUrls: product.variantUrls,
          material: product.material,
          category: product.category,
          subcategory: product.subcategory,
          breadcrumbCount: Array.isArray(body.breadcrumbs) ? body.breadcrumbs.length : 0,
          styleKeywords: product.styleKeywords,
          gtin: product.gtin,
          mpn: product.mpn,
          sku: product.sku,
          description: product.description,
          specCount: Array.isArray(body.specs) ? body.specs.length : 0,
          candidates: Array.isArray(body.images) ? body.images.length : 0,
          sizeCandidates: Array.isArray(body.sizes) ? body.sizes.length : 0,
          priceText: typeof body.priceText === "string" ? body.priceText : "",
        });
        return json(200, { ok: true, result: { url: body.url, status: "imported", name: product.name } });
      } catch (e) {
        return json(500, { error: e.message });
      }
    }

    try {
      const plan = planCollection({
        startUrl: body.url,
        html: body.html || undefined,
        robotsTxt: body.robotsTxt,
        sitemaps: body.sitemaps || [],
        seen: body.seen || [],
        limit: Number(body.limit) || 60,
      });
      return json(200, { ok: true, ...plan });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  res.writeHead(404);
  res.end("no");
});

server.listen(PORT, HOST, () => console.log(`studio on http://${HOST}:${PORT}`));
