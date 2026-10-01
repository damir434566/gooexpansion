/**
 * A store's sitemaps reach the planner in pieces that fit one plan call.
 *
 * A sitemap that lists every address once per language runs to tens of
 * megabytes. Up to 1.0.12 the extension fetched every sitemap the planner
 * named and sent them in one message. Chrome refuses an extension
 * message over 64 MB, so the run halted with "The collect tab is not
 * reachable". Vercel refuses a body over 4.5 MB, so even one such sitemap
 * could never be planned from. 1.0.13 cuts each document down to what the
 * planner reads and sends it in pieces.
 *
 * Runs the extension's own module against the shipping parser: the planner
 * must read from the pieces exactly what it read from the document.
 */
const path = require("path");
const Module = require("module");
const { pathToFileURL } = require("url");

const COMPILED = path.join(__dirname, "compiled");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(COMPILED, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

const PARSER = path.join(COMPILED, "lib", "server", "parser");
const sitemap = require(path.join(PARSER, "sitemap.js"));
const { planCollection } = require(path.join(PARSER, "plan-collection.js"));

let pass = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else failures.push(`${name}\n     got  ${JSON.stringify(got).slice(0, 400)}\n     want ${JSON.stringify(want).slice(0, 400)}`);
}

const VERCEL_BODY_LIMIT = 4_500_000;
const CHROME_MESSAGE_LIMIT = 64 * 1024 * 1024;
const FF = "https://www.farfetch.com";
const LOCALES = Array.from({ length: 40 }, (_, i) => `l${String(i).padStart(2, "0")}-xx`);

/** A product sitemap shaped like Farfetch's: alternates and a photo on every address. */
function farfetchSitemap(n, count, locales = LOCALES) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = `/shopping/men/sneaker-${n}-${i}-item-${10_000_000 + n * 100_000 + i}.aspx`;
    out.push(
      `<url><loc>${FF}${p}</loc>` +
        locales.map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${FF}/${l}${p}"/>`).join("") +
        `<image:image><image:loc>https://cdn-images.farfetch-contents.com/${i}.jpg</image:loc></image:image>` +
        `<lastmod>2026-09-30</lastmod></url>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ` +
    `xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    out.join("\n") +
    `\n</urlset>\n`
  );
}

/** What the planner reads from a list of documents, merged. */
function readAll(docs) {
  const locs = [];
  const titles = new Map();
  for (const d of docs) {
    locs.push(...sitemap.locations(d.xml));
    if (sitemap.titles) for (const [k, v] of sitemap.titles(d.xml)) titles.set(k, v);
  }
  return { locs, titles: [...titles] };
}

(async () => {
  const pieces = await import(pathToFileURL(path.join(__dirname, "..", "extension", "sitemap-pieces.js")).href);
  const { sitemapPieces, takePieces, queuedBytes, PLAN_SITEMAP_BUDGET, PLAN_SITEMAP_DOCS } = pieces;

  // ── What went wrong: eight Farfetch sitemaps in one message ─────────────────
  {
    const one = farfetchSitemap(1, 8_000);
    check("one Farfetch-shaped sitemap is already over Vercel's limit", one.length > VERCEL_BODY_LIMIT, true);
    // 1.0.12 put every sitemap the planner named (up to eight) in one message.
    const message = JSON.stringify({ sitemaps: Array.from({ length: 8 }, (_, i) => ({ url: `${FF}/sitemap-${i}.xml`, xml: one })) });
    check("eight together are over the 64 MB Chrome carries in one message", message.length > CHROME_MESSAGE_LIMIT, true);
  }

  // ── A big sitemap: cut, and nothing lost ────────────────────────────────────
  // Thirty thousand addresses with ten alternates each, about 40 MB: inside the
  // protocol's 50 MB, and still more than one plan call can carry once cut down.
  const bigXml = farfetchSitemap(3, 30_000, LOCALES.slice(0, 10));
  {
    const url = `${FF}/sitemap-products-1.xml`;
    const xml = bigXml;
    const cut = sitemapPieces(url, xml);
    check("it is cut into pieces", cut.length > 1, true);
    check("every piece fits the budget", cut.every((p) => p.bytes <= PLAN_SITEMAP_BUDGET), true);
    check("the budget leaves room under Vercel's limit", PLAN_SITEMAP_BUDGET < VERCEL_BODY_LIMIT / 2, true);
    check("every piece keeps its document's address", cut.every((p) => p.url === url), true);
    check("no piece reads as an index", cut.some((p) => sitemap.isIndex(p.xml)), false);
    check("the planner reads every address the document lists, in order", readAll(cut).locs, sitemap.locations(xml));
    const total = cut.reduce((n, p) => n + p.bytes, 0);
    check("and the hreflang copies are gone: under a tenth of the size", total < xml.length / 10, true);
    check("a sitemap inside the protocol's 50 MB is still past Vercel's limit", xml.length < 50_000_000 && xml.length > VERCEL_BODY_LIMIT, true);
    check("a piece's byte count is its UTF-8 length", cut.every((p) => p.bytes === Buffer.byteLength(p.xml)), true);
  }

  // ── An index stays an index ─────────────────────────────────────────────────
  {
    const xml =
      `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      Array.from({ length: 30 }, (_, i) => `<sitemap><loc>${FF}/sitemap-products-${i}.xml</loc><lastmod>2026-09-30</lastmod></sitemap>`).join("") +
      `</sitemapindex>`;
    const cut = sitemapPieces(`${FF}/sitemap.xml`, xml);
    check("a small index is one piece", cut.length, 1);
    check("which the planner still reads as an index", sitemap.isIndex(cut[0].xml), true);
    check("naming the same children", sitemap.locations(cut[0].xml), sitemap.locations(xml));
    const raw = planCollection({ startUrl: `${FF}/lt/shopping/men/shoes-2/items.aspx`, sitemaps: [{ url: `${FF}/sitemap.xml`, xml }], limit: 30 });
    const fromPieces = planCollection({ startUrl: `${FF}/lt/shopping/men/shoes-2/items.aspx`, sitemaps: cut, limit: 30 });
    check("and the planner asks for the same sitemaps next", fromPieces.fetchNext, raw.fetchNext);
  }

  // ── The spellings sitemap.ts reads: CDATA, &amp;, titles ────────────────────
  {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc><![CDATA[ https://shop.example/products/samba-og ]]></loc>
    <image:image><image:loc>https://cdn.shop.example/a.jpg</image:loc><image:title><![CDATA[Samba OG 'Cloud White']]></image:title></image:image></url>
  <url><loc>https://shop.example/products/tee?color=black&amp;size=m</loc>
    <image:image><image:title>Tee &amp; Co &#39;Black&#39;</image:title></image:image></url>
  <url><loc>https://shop.example/products/kurtka</loc><image:image><image:title>Куртка бомбер</image:title></image:image></url>
  <url><loc>https://shop.example/pages/about</loc></url>
</urlset>`;
    const cut = sitemapPieces("https://shop.example/sitemap_products_1.xml", xml);
    const raw = readAll([{ xml }]);
    const got = readAll(cut);
    check("CDATA and &amp; addresses read the same from a piece", got.locs, raw.locs);
    check("Shopify's titles read the same from a piece", got.titles, raw.titles);
    check("including one in Cyrillic", got.titles.some(([, t]) => t === "Куртка бомбер"), true);
    const kurtka = sitemapPieces("https://shop.example/s.xml", xml, 120);
    check("a tight budget is counted in bytes, not letters", kurtka.every((p) => Buffer.byteLength(p.xml) <= 120 || sitemap.locations(p.xml).length === 1), true);
    check("and still loses nothing", readAll(kurtka).locs, raw.locs);
    const a = planCollection({ startUrl: "https://shop.example/collections/all", sitemaps: [{ url: "https://shop.example/sitemap_products_1.xml", xml }], limit: 30 });
    const b = planCollection({ startUrl: "https://shop.example/collections/all", sitemaps: cut, limit: 30 });
    check("the planner plans the same addresses from the piece", b.urls, a.urls);
    check("and counts the same addresses seen", b.locsSeen, a.locsSeen);
  }

  // ── Not a sitemap at all ────────────────────────────────────────────────────
  {
    const html = "<!doctype html><html><body><h1>Page not found</h1></body></html>";
    const cut = sitemapPieces("https://shop.example/sitemap1.xml", html);
    check("an HTML page at a guessed address is one empty piece", cut.length, 1);
    check("with no address in it", sitemap.locations(cut[0].xml), []);
    const plan = planCollection({ startUrl: "https://shop.example/collections/all", sitemaps: cut, limit: 30 });
    check("which the planner records as read, so no guessing starts over", plan.fetchNext.some((u) => /sitemap1\.xml$/.test(u)), false);
  }

  // ── One plan call's worth ───────────────────────────────────────────────────
  {
    const big = sitemapPieces(`${FF}/a.xml`, bigXml);
    const queue = [...big];
    const before = queue.length;
    const first = takePieces(queue);
    check("a batch is never over the budget", first.reduce((n, p) => n + Buffer.byteLength(p.xml), 0) <= PLAN_SITEMAP_BUDGET, true);
    check("and is taken off the queue", queue.length, before - first.length);
    check("a batch sends only the address and the text", Object.keys(first[0]).sort(), ["url", "xml"]);
    const small = Array.from({ length: 20 }, (_, i) => sitemapPieces(`${FF}/s${i}.xml`, `<urlset><url><loc>${FF}/x-item-${i}.aspx</loc></url></urlset>`)[0]);
    const smalls = takePieces(small);
    check("small documents share a call, up to the route's twelve", smalls.length, PLAN_SITEMAP_DOCS);
    check("the rest wait for the next one", small.length, 20 - PLAN_SITEMAP_DOCS);
    const oversized = [{ url: "u", xml: "x".repeat(10), bytes: PLAN_SITEMAP_BUDGET + 1 }];
    check("a piece bigger than the budget is still taken, so nothing stalls", takePieces(oversized).length, 1);
    check("queued bytes add up", queuedBytes(big), big.reduce((n, p) => n + p.bytes, 0));

    // The whole request the collect tab posts, with the most it can carry.
    const seen = Array.from({ length: 2_000 }, (_, i) => `${FF}/shopping/men/a-long-product-name-${i}-item-${20_000_000 + i}.aspx`);
    const body = JSON.stringify({
      action: "plan",
      url: `${FF}/lt/shopping/men/shoes-2/items.aspx`,
      html: "",
      robotsTxt: "User-agent: *\nDisallow: /checkout\n".repeat(2_000),
      sitemaps: takePieces([...big]),
      seen,
      limit: 2_000,
      linksOnly: false,
    });
    check("a whole plan request stays under Vercel's 4.5 MB", Buffer.byteLength(body) < VERCEL_BODY_LIMIT, true);
  }

  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
