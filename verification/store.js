/**
 * A fixture store: the only shop this test is allowed to be rude to.
 *
 * Modes:
 *   normal — 5 products, Crawl-delay 2, one product disallowed by robots.txt
 *   refuse — every product answers 403
 *   many   — 21 products, no Crawl-delay (so the 1.5s floor applies)
 *
 * Records every request with a timestamp so the test can assert on pacing.
 */
const http = require("http");

const PORT = Number(process.env.STORE_PORT || 3301);
const HOST = "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;

let mode = "normal";
let log = [];

function products() {
  if (mode === "many") return Array.from({ length: 21 }, (_, i) => `p${i + 1}`);
  return ["alpha", "beta", "gamma", "delta", "secret-hidden"];
}

function robots() {
  const lines = ["User-agent: Googlebot", "Disallow:", "", "User-agent: *"];
  // A path the run must never open. If it does, the test fails loudly.
  lines.push("Disallow: /product/secret-");
  if (mode !== "many") lines.push("Crawl-delay: 2");
  lines.push("", `Sitemap: ${ORIGIN}/sitemap.xml`);
  return lines.join("\n") + "\n";
}

function sitemap() {
  const locs = products()
    .map((slug) => `  <url><loc>${ORIGIN}/product/${slug}</loc></url>`)
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
  const links = products()
    .map((s) => `<a href="/product/${s}">${s}</a>`)
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
    res.writeHead(code, { "content-type": type });
    res.end(body);
  };

  if (p === "/robots.txt") return send(200, "text/plain", robots());
  if (p === "/sitemap.xml") return send(200, "application/xml", sitemap());
  if (p === "/collections/all" || p === "/") return send(200, "text/html", categoryPage());

  if (p.startsWith("/product/")) {
    if (mode === "refuse") return send(403, "text/html", "<html><body>Go away</body></html>");
    const slug = p.slice("/product/".length);
    if (!products().includes(slug)) return send(404, "text/html", "<html>no</html>");
    return send(200, "text/html", productPage(slug));
  }

  if (p === "/about") return send(200, "text/html", "<html><body>About</body></html>");
  if (p.startsWith("/img/")) return send(200, "image/gif", Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
  if (p === "/style.css") return send(200, "text/css", "body{margin:0}");
  return send(404, "text/html", "<html>no</html>");
});

server.listen(PORT, HOST, () => console.log(`store on ${ORIGIN}`));
