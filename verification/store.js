/**
 * A fixture store: the only shop this test is allowed to be rude to.
 *
 * Modes:
 *   normal — 5 products, Crawl-delay 2, one product disallowed by robots.txt
 *   refuse — every product answers 403
 *   many   — 21 products, no Crawl-delay (so the 1.5s floor applies)
 *   spa    — two pages built the way a single-page storefront builds them:
 *            the gallery lives in a hydration payload rather than in markup,
 *            and one of them never states its currency outside rendered text
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
    color: "Charcoal",
    offers: { "@type": "Offer", price: "1290", priceCurrency: "EUR" },
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
<h1>Wool-blend bomber jacket</h1>
<div class="carousel">
  <img src="${hero}" alt="">
  <img src="${ORIGIN}/cdn/${SPA_GALLERY[0]}" alt="">
</div>
<div class="price-area"><span class="price">€1,290</span></div>
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
    brand: { "@type": "Brand", name: "Fixture UA" },
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
<div class="product-price"><span class="price">4 000 ₴</span></div>
<img src="${ORIGIN}/cdn/bomber-ua-1.jpg" alt="">
<img src="${ORIGIN}/cdn/bomber-ua-2.jpg" alt="">
</body></html>`;
}

function robots() {
  const lines = ["User-agent: Googlebot", "Disallow:", "", "User-agent: *"];
  // A path the run must never open. If it does, the test fails loudly.
  lines.push("Disallow: /product/secret-");
  if (mode !== "many" && mode !== "spa") lines.push("Crawl-delay: 2");
  lines.push("", `Sitemap: ${ORIGIN}/sitemap.xml`);
  return lines.join("\n") + "\n";
}

function sitemap() {
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

function categoryPage() {
  const links = (mode === "spa" ? SPA_PATHS : products().map((s) => `/product/${s}`))
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
      if (next.reset) log = [];
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

  log.push({ path: p, at: Date.now() });

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
  if (p === "/sitemap.xml") return send(200, "application/xml", sitemap());
  if (p === "/collections/all" || p === "/") return send(200, "text/html", categoryPage());

  if (mode === "spa") {
    if (p === SPA_PATHS[0]) return send(200, "text/html", spaProductPage());
    if (p === SPA_PATHS[1]) return send(200, "text/html", uahProductPage());
  }

  if (p.startsWith("/product/")) {
    if (mode === "refuse") return send(403, "text/html", "<html><body>Go away</body></html>");
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
