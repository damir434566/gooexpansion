/**
 * A fixture store: the only shop this test is allowed to be rude to.
 *
 * Modes:
 *   normal — 5 products, Crawl-delay 2, one product disallowed by robots.txt
 *   refuse — every product answers 403
 *   check  — every product answers 200 with a bot check (Akamai's "Access Denied")
 *   soldout — "beta" is sold out: its address redirects to a category
 *   many   — 21 products, no Crawl-delay (so the 1.5s floor applies)
 *   spa    — two pages built the way a single-page storefront builds them:
 *            the gallery lives in a hydration payload rather than in markup,
 *            and one of them never states its currency outside rendered text
 *   page   — a category the way stores build them now: eight cards in the
 *            markup, more as it scrolls (an IntersectionObserver, which does
 *            nothing in a tab nobody can see), cards taken away again as they
 *            scroll off, a "Show more" under the grid, a second page, and a
 *            "Show more" in the filter panel that must never be pressed. 36
 *            jackets; jacket-13 answers 500 the first time it is opened. The
 *            same listing also stands at an address numbered like a piece
 *            (`/ua/men/clothes/jackets-c1010193222.html`, as Bershka numbers
 *            its categories) and at `/c/coats`, whose markup calls it one
 *            product (og:type product, a Product with an AggregateOffer).
 *            Product pages here carry a "You may also like" rail of three.
 *   bigmap — sitemaps the size Farfetch's are: an index naming three product
 *            sitemaps that list every address in ten languages, about 90 MB
 *            between them. The category page links two products; the other
 *            two are only in the first sitemap.
 *
 * Records every request with a timestamp so the test can assert on pacing.
 */
const http = require("http");

const PORT = Number(process.env.STORE_PORT || 3301);
const HOST = "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;

let mode = "normal";
let log = [];

/**
 * The two pages of the `spa` mode, addressed the way the sites they stand in
 * for address theirs: a Farfetch-shaped `…-item-<code>.aspx`, and an ordinary
 * product path on a store that prices in hryvnia.
 */
const SPA_PATHS = [
  "/shopping/women/wool-blend-bomber-jacket-item-28530033.aspx",
  "/product/kurtka-bomber",
];

function products() {
  if (mode === "many") return Array.from({ length: 21 }, (_, i) => `p${i + 1}`);
  if (mode === "page") return Array.from({ length: PAGE_TOTAL }, (_, i) => `jacket-${i + 1}`);
  return ["alpha", "beta", "gamma", "delta", "secret-hidden"];
}

/** The gallery this product has, all of it. Six shots the markup never names. */
const SPA_GALLERY = [
  "28530033_54830862_1000.jpg",
  "28530033_54830863_1000.jpg",
  "28530033_54830864_1000.jpg",
  "28530033_54830865_1000.jpg",
  "28530033_54830866_1000.jpg",
  "28530033_54830867_1000.jpg",
];

/** Another product's photos, on the same CDN, in a recommendations rail. */
const SPA_OTHER = ["31224455_49999901_1000.jpg", "31224455_49999902_1000.jpg"];

/**
 * A page shaped like a single-page storefront's.
 *
 * Everything that matters about it is where the photos are. Structured data
 * advertises one. The carousel has mounted two, because that is what it had
 * scrolled past. The remaining six exist only inside `__NEXT_DATA__` — which is
 * a `<script>`, which is precisely what the content script deletes before
 * sending the page. Half of them are written with escaped slashes, the way a
 * JSON payload actually carries a URL.
 */
function spaProductPage() {
  const hero = `${ORIGIN}/cdn/28530033_54830861_1000.jpg`;
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Wool-blend bomber jacket",
    brand: { "@type": "Brand", name: "Fixture Atelier" },
    image: hero,
    // A real EAN-13, and a part number: the codes that let a second retailer's
    // page join this product instead of becoming a second copy of it.
    offers: {
      "@type": "Offer",
      price: "1290",
      priceCurrency: "EUR",
      gtin13: "4006381333931",
      sku: "FF-28530033",
    },
    mpn: "FA-2285",
  });

  // Written by hand rather than with JSON.stringify, because the escaping is
  // the point: half these URLs carry `\/` for every slash, which is how a
  // payload that has been JSON-encoded twice spells an address, and is the form
  // the harvester has to unescape. JSON.stringify would leave slashes plain and
  // quietly test nothing.
  const plain = SPA_GALLERY.slice(0, 3).map((f) => `"${ORIGIN}/cdn/${f}"`);
  const escaped = SPA_GALLERY.slice(3).map(
    (f) => `"${`${ORIGIN}/cdn/${f}`.replace(/\//g, "\\/")}"`,
  );
  const others = SPA_OTHER.map((f) => `{"image":"${ORIGIN}/cdn/${f}"}`);
  const payload =
    `{"props":{"pageProps":{"product":{"id":28530033,"images":[` +
    `${[...plain, ...escaped].join(",")}]},` +
    `"recommendations":[${others.join(",")}]}}}`;

  const bulk = "/* padding */ var x = '" + "z".repeat(400_000) + "';";
  return `<!doctype html><html><head>
<title>Wool-blend bomber jacket | Fixture</title>
<script type="application/ld+json">${ld}</script>
<script id="__NEXT_DATA__" type="application/json">${payload}</script>
<script>${bulk}</script>
<style>.a{color:#fff}${".b{}".repeat(50_000)}</style>
</head><body>
<nav class="breadcrumbs" aria-label="Breadcrumb">
  <a href="/women">Women</a>
  <a href="/women/clothing">Clothing</a>
  <a href="/women/clothing/jackets">Jackets</a>
  <span>Wool-blend bomber jacket</span>
</nav>
<h1>Wool-blend bomber jacket</h1>
<div class="carousel">
  <img src="${hero}" alt="">
  <img src="${ORIGIN}/cdn/${SPA_GALLERY[0]}" alt="">
</div>
<div class="price-area"><span class="price">€1,290</span></div>
<div class="colour-selector" data-testid="colour-picker">
  <span class="colour-label">Colour: Charcoal</span>
  <button class="swatch selected" aria-checked="true" aria-label="Charcoal"></button>
  <a class="swatch" href="/shopping/women/wool-blend-bomber-jacket-item-28530034.aspx" aria-label="Sand"></a>
  <a class="swatch" href="/shopping/women/wool-blend-bomber-jacket-item-28530035.aspx" aria-label="Navy"></a>
  <a class="care-link" href="/care">Care instructions</a>
</div>
<div class="size-selector" data-testid="size-picker">
  <label class="size-label">Select size</label>
  <button data-size="XS">XS</button>
  <button data-size="S">S</button>
  <button data-size="M">M</button>
  <button class="sold-out" data-size="L" disabled>L</button>
  <button data-size="XL">XL</button>
  <a class="size-guide-link" href="/size-guide">Size guide</a>
</div>
<div class="quantity"><button>-</button><button>1</button><button>+</button></div>
<div class="accordion">
  <button class="accordion-head">Details</button>
  <div class="product-description" style="display:none">
    Cut from a wool blend with a boxy shoulder and a cropped hem, this bomber is
    a pared-back essential finished with ribbed trims and a two-way zip. The
    model is 178cm and wears a size S.
  </div>
</div>
<div class="product-specs">
  <dl>
    <dt>Composition</dt><dd>80% wool, 20% polyamide</dd>
    <dt>Article number</dt><dd>FA-2285-CH</dd>
    <dt>Care</dt><dd>Dry clean only</dd>
    <dt>Made in</dt><dd>Italy</dd>
  </dl>
</div>
<div class="recommendations">
  <h2>You may also like</h2>
  <img src="${ORIGIN}/cdn/${SPA_OTHER[0]}" alt="">
</div>
</body></html>`;
}

/**
 * A store that prices in hryvnia and says so nowhere a parser can read.
 *
 * Its structured data carries a bare `4000` with no `priceCurrency`, which is
 * common and is exactly the case that used to import as four thousand dollars.
 * The symbol is in the rendered text, where only a browser can see it.
 */
function uahProductPage() {
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Куртка бомбер",
    image: `${ORIGIN}/cdn/bomber-ua-1.jpg`,
    offers: { "@type": "Offer", price: "4000" },
    hasVariant: [
      { "@type": "Product", size: "44" },
      { "@type": "Product", size: "46" },
    ],
  });
  return `<!doctype html><html><head>
<title>Куртка бомбер</title>
<script type="application/ld+json">${ld}</script>
</head><body>
<h1>Куртка бомбер</h1>
<a class="brand-link" href="/brands/fixture-ua">Fixture UA</a>
<div class="product-price"><span class="price">4 000 ₴</span></div>
<img src="${ORIGIN}/cdn/bomber-ua-1.jpg" alt="">
<img src="${ORIGIN}/cdn/bomber-ua-2.jpg" alt="">
<div class="specs">
  Склад: 95% бавовна, 5% еластан
  Догляд: машинне прання 30°
  Артикул: UA-88213
</div>
</body></html>`;
}

function robots() {
  const lines = ["User-agent: Googlebot", "Disallow:", "", "User-agent: *"];
  // A path the run must never open. If it does, the test fails loudly.
  lines.push("Disallow: /product/secret-");
  if (mode !== "many" && mode !== "spa" && mode !== "bigmap" && mode !== "page") lines.push("Crawl-delay: 2");
  lines.push("", `Sitemap: ${ORIGIN}/sitemap.xml`);
  return lines.join("\n") + "\n";
}

/** The `bigmap` store's product sitemaps, and how many addresses each lists. */
const BIGMAP_CHILDREN = 3;
const BIGMAP_ENTRIES = 25_000;
/** Locales every address is repeated in, the way Farfetch's sitemaps repeat them. */
const BIGMAP_LOCALES = Array.from({ length: 10 }, (_, i) => `l${String(i).padStart(2, "0")}-xx`);
/** The two products only the sitemap knows, at the top of the first one. */
const BIGMAP_SITEMAP_ONLY = ["gamma", "delta"];
const bigmapCache = new Map();

function bigmapIndex() {
  const children = Array.from(
    { length: BIGMAP_CHILDREN },
    (_, i) => `  <sitemap><loc>${ORIGIN}/sitemap-products-${i + 1}.xml</loc></sitemap>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${children}\n</sitemapindex>\n`;
}

/**
 * One product sitemap of the `bigmap` store, around 30 MB.
 *
 * Built once and kept: the run fetches each child once, but generating 80 MB
 * of XML per request would make the fixture the slow part of the test.
 */
function bigmapChild(n) {
  if (bigmapCache.has(n)) return bigmapCache.get(n);
  const entry = (pathname, title) =>
    `<url><loc>${ORIGIN}${pathname}</loc>` +
    BIGMAP_LOCALES.map(
      (l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${ORIGIN}/${l}${pathname}"/>`,
    ).join("") +
    `<image:image><image:loc>${ORIGIN}/img${pathname}.jpg</image:loc><image:title>${title}</image:title></image:image></url>`;
  const parts = [];
  if (n === 1) for (const slug of BIGMAP_SITEMAP_ONLY) parts.push(entry(`/product/${slug}`, `Fixture ${slug} Coat`));
  // Addresses nobody opens: the run asks for four products and finds them first.
  for (let i = 0; i < BIGMAP_ENTRIES; i++) parts.push(entry(`/product/gone-${n}-${i}`, `Gone ${n}-${i} Coat`));
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ` +
    `xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    parts.join("\n") +
    `\n</urlset>\n`;
  bigmapCache.set(n, xml);
  return xml;
}

function sitemap() {
  if (mode === "bigmap") return bigmapIndex();
  const locs = (mode === "spa" ? SPA_PATHS : products().map((slug) => `/product/${slug}`))
    .map((pathname) => `  <url><loc>${ORIGIN}${pathname}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs}\n  <url><loc>${ORIGIN}/about</loc></url>\n</urlset>\n`;
}

/**
 * A product page shaped like a real one: JSON-LD for the parser, a lazy gallery
 * that only becomes real `<img src>` after a scroll, and a megabyte of script
 * and style for the content script to strip.
 */
function productPage(slug) {
  const name = slug.replace(/(^|-)([a-z])/g, (_, d, c) => (d ? " " : "") + c.toUpperCase()).trim();
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: `Fixture ${name} Coat`,
    brand: { "@type": "Brand", name: "Fixture Atelier" },
    image: [`${ORIGIN}/img/${slug}-1.jpg`, `${ORIGIN}/img/${slug}-2.jpg`],
    color: "Charcoal",
    material: "Wool",
    description: "A coat that exists only in a test.",
    offers: { "@type": "Offer", price: "249.00", priceCurrency: "EUR" },
  });
  const bulk = "/* padding */ var x = '" + "z".repeat(400_000) + "';";
  return `<!doctype html><html><head>
<title>Fixture ${name} Coat</title>
<script type="application/ld+json">${ld}</script>
<script>${bulk}</script>
<style>.a{color:#fff}${".b{}".repeat(50_000)}</style>
<link rel="stylesheet" href="${ORIGIN}/style.css">
</head><body>
<h1>Fixture ${name} Coat</h1>
<svg viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg>
<iframe src="${ORIGIN}/frame"></iframe>
${
  mode === "page"
    ? `<section class="related"><h2>You may also like</h2>${[1, 2, 3]
        .filter((i) => `jacket-${i}` !== slug)
        .slice(0, 3)
        .map((i) => `<a href="/product/jacket-${i}">Jacket ${i}</a>`)
        .join(" ")}</section>`
    : ""
}
<img id="hero" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="${ORIGIN}/img/${slug}-1.jpg">
<div id="gallery"></div>
<script>
  // The lazy gallery the extension's scroll is meant to wake up.
  addEventListener('scroll', function once() {
    removeEventListener('scroll', once);
    var g = document.getElementById('gallery');
    g.innerHTML = '<img class="lazy" src="${ORIGIN}/img/${slug}-2.jpg">';
    document.getElementById('hero').src = '${ORIGIN}/img/${slug}-1.jpg';
  });
</script>
</body></html>`;
}

/** The `page` store: jackets on page one, the last six on page two. */
const PAGE_ONE = 30;
const PAGE_TOTAL = 36;
/** Addresses that have already failed once, so a retry finds them working. */
const flakyServed = new Set();
/** The `page` store's listings, each serving the same jackets. */
const PAGE_LISTINGS = {
  "/c/jackets": { dressed: false },
  "/ua/men/clothes/jackets-c1010193222.html": { dressed: false },
  "/c/coats": { dressed: true },
};

/**
 * A category page of the `page` store.
 *
 * Page one ships eight cards. An IntersectionObserver under the grid loads
 * eight more at a time from `/api/cards` up to 24, then a "Show more" button
 * under the grid loads the last six; past twenty cards the oldest are taken
 * out of the page, the way a virtualised grid does it. Page two is six cards
 * in plain markup. The filter panel's own "Show more" fetches `/__filters-more`
 * so the test can see if it was ever pressed.
 */
function listingPage(page, base = "/c/jackets", dressed = false) {
  const card = (i) =>
    `<div class="card"><a href="/product/jacket-${i}"><img alt="" src="/img/jacket-${i}-1.jpg"></a>` +
    `<a href="/product/jacket-${i}">Jacket ${i}</a> <a href="/product/jacket-${i}?color=red">red</a></div>`;
  const first = page === 1 ? [1, 2, 3, 4, 5, 6, 7, 8] : [31, 32, 33, 34, 35, 36];
  const pager =
    page === 1
      ? `<a href="${base}">1</a> <a href="${base}?page=2">2</a> <a href="${base}?page=2" rel="next">Next</a>`
      : `<a href="${base}">1</a> <span>2</span>`;
  // A category marked up as one product, the way some stores dress a category
  // for search results: a Product whose offer is the range of the whole grid.
  const dress = dressed
    ? `<meta property="og:type" content="product">
<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Jackets",
        image: `${ORIGIN}/img/store-logo.png`,
        offers: { "@type": "AggregateOffer", lowPrice: "40", highPrice: "900", priceCurrency: "EUR", offerCount: PAGE_TOTAL },
      })}</script>`
    : `<meta property="og:type" content="website">`;
  return `<!doctype html><html><head><title>Jackets</title>
<meta property="og:image" content="${ORIGIN}/img/store-logo.png">
${dress}
<style>
  body { margin: 0; font: 14px sans-serif; }
  header { height: 60px; }
  aside { position: absolute; top: 70px; right: 0; width: 140px; }
  .card { height: 320px; border-bottom: 1px solid #ddd; }
  .card img { width: 120px; height: 160px; }
</style></head><body>
<header><nav><a href="/">Home</a> <a href="/c/shoes">Shoes</a> <a href="/about">About</a></nav></header>
<aside class="filters"><a href="/c/jackets?color=black">Black</a>
  <button id="filters-more" onclick="fetch('/__filters-more')">Show more</button></aside>
<main>
  <h1>Jackets</h1>
  <div id="grid">${first.map(card).join("")}${page === 1 ? '<div class="card"><a href="/product/secret-jacket">Secret</a></div>' : ""}</div>
  <div id="sentinel" style="height: 1px"></div>
  <div id="more-wrap"></div>
  <div id="pages">${pager}</div>
</main>
<footer><a href="/help">Help</a> <a href="/cart">Cart</a></footer>
${
  page === 1
    ? `<script>
  const grid = document.getElementById("grid");
  let n = 8;
  let busy = false;
  const card = (i) => '<div class="card"><a href="/product/jacket-' + i + '"><img alt="" src="/img/jacket-' + i + '-1.jpg"></a>' +
    '<a href="/product/jacket-' + i + '">Jacket ' + i + '</a> <a href="/product/jacket-' + i + '?color=red">red</a></div>';
  async function load(count) {
    busy = true;
    const ids = await (await fetch("/api/cards?from=" + n + "&count=" + count)).json();
    await new Promise((r) => setTimeout(r, 300));
    for (const i of ids) grid.insertAdjacentHTML("beforeend", card(i));
    n += ids.length;
    while (grid.children.length > 20) grid.removeChild(grid.firstChild);
    busy = false;
    if (n >= 24 && n < ${PAGE_ONE} && !document.getElementById("more")) {
      document.getElementById("more-wrap").innerHTML = '<button id="more">Show more</button>';
      document.getElementById("more").onclick = async () => {
        await load(${PAGE_ONE} - n);
        document.getElementById("more-wrap").innerHTML = "";
      };
    }
  }
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !busy && n < 24) load(8);
  }).observe(document.getElementById("sentinel"));
</script>`
    : ""
}
</body></html>`;
}

function categoryPage() {
  const shown =
    mode === "bigmap" ? products().filter((s) => !BIGMAP_SITEMAP_ONLY.includes(s) && !s.startsWith("secret")) : products();
  const links = (mode === "spa" ? SPA_PATHS : shown.map((s) => `/product/${s}`))
    .map((href) => `<a href="${href}">${href}</a>`)
    .join("\n");
  return `<!doctype html><html><head><title>All</title></head><body>
<h1>Everything</h1>${links}
<a href="/about">About us</a><a href="/cart">Cart</a>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;

  if (p === "/__control" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const next = JSON.parse(body || "{}");
      if (next.mode) mode = next.mode;
      if (next.reset) {
        log = [];
        flakyServed.clear();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode }));
    });
    return;
  }

  if (p === "/__log") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mode, log }));
    return;
  }

  log.push({ path: p, search: url.search, at: Date.now() });

  const send = (code, type, body) => {
    // Charset declared, because a page that does not declare one is decoded as
    // latin-1 by the browser and "Куртка бомбер" arrives as mojibake — which
    // would have this fixture testing the harness's own encoding bug rather
    // than the store it stands in for.
    const withCharset = /^text\//.test(type) ? `${type}; charset=utf-8` : type;
    res.writeHead(code, { "content-type": withCharset });
    res.end(body);
  };

  if (p === "/robots.txt") return send(200, "text/plain", robots());

  if (mode === "page") {
    const listing = PAGE_LISTINGS[p];
    if (listing) return send(200, "text/html", listingPage(url.searchParams.get("page") === "2" ? 2 : 1, p, listing.dressed));
    if (p === "/api/cards") {
      const from = Number(url.searchParams.get("from")) || 0;
      const count = Number(url.searchParams.get("count")) || 0;
      const ids = [];
      for (let i = from + 1; i <= Math.min(from + count, PAGE_ONE); i++) ids.push(i);
      return send(200, "application/json", JSON.stringify(ids));
    }
    if (p === "/__filters-more") return send(200, "application/json", "[]");
    if (p === "/product/jacket-13" && !flakyServed.has(p)) {
      flakyServed.add(p);
      return send(500, "text/html", "<html><body>Something went wrong</body></html>");
    }
  }
  if (p === "/sitemap.xml") return send(200, "application/xml", sitemap());
  const child = mode === "bigmap" && /^\/sitemap-products-(\d+)\.xml$/.exec(p);
  if (child && Number(child[1]) >= 1 && Number(child[1]) <= BIGMAP_CHILDREN) {
    return send(200, "application/xml", bigmapChild(Number(child[1])));
  }
  if (p === "/collections/all" || p === "/") return send(200, "text/html", categoryPage());
  if (p === "/collections/women") return send(200, "text/html", categoryPage());

  if (mode === "spa") {
    if (p === SPA_PATHS[0]) return send(200, "text/html", spaProductPage());
    if (p === SPA_PATHS[1]) return send(200, "text/html", uahProductPage());
  }

  if (p.startsWith("/product/")) {
    if (mode === "refuse") return send(403, "text/html", "<html><body>Go away</body></html>");
    if (mode === "check") {
      return send(
        200,
        "text/html",
        `<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>You don't have permission to access "${ORIGIN}${p}" on this server.<p>Reference #18.6a2c1002</p></body></html>`,
      );
    }
    if (mode === "soldout" && p === "/product/beta") {
      res.writeHead(302, { location: "/collections/women" });
      return res.end();
    }
    const slug = p.slice("/product/".length);
    if (!products().includes(slug)) return send(404, "text/html", "<html>no</html>");
    return send(200, "text/html", productPage(slug));
  }

  if (p === "/about") return send(200, "text/html", "<html><body>About</body></html>");
  if (p.startsWith("/img/") || p.startsWith("/cdn/")) {
    return send(200, "image/gif", Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
  }
  if (p === "/style.css") return send(200, "text/css", "body{margin:0}");
  return send(404, "text/html", "<html>no</html>");
});

server.listen(PORT, HOST, () => console.log(`store on ${ORIGIN}`));
