/**
 * Only product pages become products, and only a product's own photos go on it.
 *
 * Farfetch keeps every page under `/shopping/…` and ends every address in
 * `.aspx` — its categories (`/shopping/women/dresses-1/items.aspx`), its
 * designers, its sale — and both were read as "this is a product". A run
 * started on a category put the category itself first in the queue and every
 * category link after it, and each came in as a piece with the photos of a
 * whole shelf. And a page that is not a product at all — a bot check shown
 * instead of it ("Access Denied", "Just a moment…"), or a category the store
 * redirected a sold-out piece to — was imported as one.
 *
 * Runs the shipping modules: the product-path test, the collect planner, the
 * guard the collect route asks before importing, and the gallery harvester.
 */
const path = require("path");
const Module = require("module");

const COMPILED = path.join(__dirname, "compiled");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(COMPILED, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

const PARSER = path.join(COMPILED, "lib", "server", "parser");
const { looksLikeProductPath, isNonProductPath } = require(path.join(PARSER, "extract.js"));
const { planCollection } = require(path.join(PARSER, "plan-collection.js"));
const { harvestGalleryImages } = require(path.join(PARSER, "gallery.js"));
let notAProductPage = null;
try {
  ({ notAProductPage } = require(path.join(PARSER, "page-guards.js")));
} catch {
  /* before the guard existed */
}

let pass = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else failures.push(`${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}

const FF = "https://www.farfetch.com";
const P1 = `${FF}/ua/shopping/women/gucci-horsebit-1955-shoulder-bag-item-19356833.aspx`;
const P2 = `${FF}/ua/shopping/men/nike-air-force-1-07-sneakers-item-24761129.aspx`;
const P3 = `${FF}/ua/shopping/women/the-row-margaux-15-bag-item-22893412.aspx`;
const CATEGORIES = [
  `${FF}/ua/shopping/women/items.aspx`,
  `${FF}/ua/shopping/women/dresses-1/items.aspx`,
  `${FF}/ua/shopping/women/gucci/items.aspx`,
  `${FF}/ua/shopping/women/sale/all/items.aspx`,
  `${FF}/ua/shopping/men/sneakers-2/items.aspx`,
  `${FF}/ua/sets/women/new-in-this-week-eu-women.aspx`,
  `${FF}/ua/designers/women`,
];

console.log("— what is a product page —");
for (const u of [P1, P2, P3]) check(`product: ${new URL(u).pathname}`, looksLikeProductPath(new URL(u).pathname), true);
for (const u of CATEGORIES) check(`not a product: ${new URL(u).pathname}`, looksLikeProductPath(new URL(u).pathname), false);
check("a category file is refused even in a product sitemap", isNonProductPath("/ua/shopping/women/dresses-1/items.aspx"), true);
// What must still be a product elsewhere.
for (const p of [
  "/products/emerson",
  "/en-us/men/product/acne-studios/wool-coat/12345678",
  "/items/12345678",
  "/p/cool-jacket-123456.aspx",
  "/shop/nebula-jacket-aurelio",
  "/productdetail.aspx",
]) check(`still a product: ${p}`, looksLikeProductPath(p), true);

console.log("— a run started on a Farfetch category —");
{
  const html = `<html><body><main>
    <a href="/ua/shopping/women/dresses-1/items.aspx">Dresses</a>
    <a href="/ua/shopping/women/gucci/items.aspx">Gucci</a>
    <a href="/ua/shopping/women/sale/all/items.aspx">Sale</a>
    <a href="/ua/designers/women">Designers</a>
    <a href="${new URL(P1).pathname}">Gucci Horsebit 1955</a>
    <a href="${new URL(P2).pathname}">Air Force 1 '07</a>
    <a href="${new URL(P3).pathname}">Margaux 15</a>
  </main></body></html>`;
  const plan = planCollection({ startUrl: CATEGORIES[1], html, robotsTxt: "", sitemaps: [], seen: [], limit: 20 });
  check("the category page itself is not queued as a piece", plan.urls.includes(CATEGORIES[1]), false);
  check("only the three pieces are queued", [...plan.urls].sort(), [P1, P2, P3].sort());
}

console.log("— a page that is not the product —");
check("the guard exists", typeof notAProductPage, "function");
const guard = (input) => (notAProductPage ? notAProductPage(input) : null);
const PRODUCT_HTML = `<html><head><title>Gucci Horsebit 1955 shoulder bag - Farfetch</title>
  <meta property="og:type" content="product"></head><body><h1>Horsebit 1955 shoulder bag</h1>
  <form class="newsletter"><div class="g-recaptcha"></div></form></body></html>`;
check("a product page passes, recaptcha in its newsletter form or not", guard({ url: P1, finalUrl: P1, html: PRODUCT_HTML }), null);
const checks = {
  "Akamai": `<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>You don't have permission to access "http://www.farfetch.com/ua/shopping/women/x-item-1.aspx" on this server.<p>Reference #18.6a2c1002.1727000000.1a2b3c</p></body></html>`,
  "Cloudflare": `<html><head><title>Just a moment...</title></head><body><h1>www.farfetch.com</h1><h2>Checking if the site connection is secure</h2><noscript>Enable JavaScript and cookies to continue</noscript></body></html>`,
  "PerimeterX": `<html><head><title>Access to this page has been denied.</title></head><body><div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human (and not a bot).</p></body></html>`,
  "DataDome": `<html><head><title>farfetch.com</title></head><body><p>Please enable JS and disable any ad blocker</p><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=abc"></iframe></body></html>`,
  "Incapsula": `<html><head><title>Request unsuccessful. Incapsula incident ID: 123</title></head><body></body></html>`,
};
for (const [who, html] of Object.entries(checks)) {
  const reason = guard({ url: P1, finalUrl: P1, html });
  check(`${who}'s bot check is not imported`, typeof reason === "string" && /check/i.test(reason), true);
}
{
  const html = `<html><head><title>Women's Dresses - Farfetch</title></head><body><h1>Dresses</h1></body></html>`;
  const reason = guard({ url: P1, finalUrl: CATEGORIES[1], html });
  check("a sold-out piece redirected to a category is not imported", typeof reason === "string" && /redirect|sent/i.test(reason), true);
  check("a locale redirect to the same piece is fine", guard({ url: P1.replace("/ua/", "/"), finalUrl: P1, html: PRODUCT_HTML }), null);
  check("no final address (an older extension) is fine", guard({ url: P1, html: PRODUCT_HTML }), null);
}

console.log("— a Farfetch product's own photos, not its neighbours' —");
{
  const cdn = "https://cdn-images.farfetch-contents.com/19/35/68/33";
  const trusted = [`${cdn}/19356833_42560043_1000.jpg`];
  const extra = [
    `${cdn}/19356833_42560044_1000.jpg`, // our second frame
    `${cdn}/19356833_42560051_480.jpg`, // our third, a smaller rendition
    "https://cdn-images.farfetch-contents.com/19/35/68/34/19356834_42560045_1000.jpg", // the next item's
    "https://cdn-images.farfetch-contents.com/24/76/11/29/24761129_54730012_1000.jpg", // a rail's
  ];
  const got = harvestGalleryImages("<html></html>", P1, trusted, "Horsebit 1955 shoulder bag", extra).map((u) => u.split("/").pop());
  check("our frames are kept", got.filter((n) => n.startsWith("19356833_")).length, 2);
  check("the neighbouring item's photo, one digit away, is not ours", got.filter((n) => !n.startsWith("19356833_")), []);
}

console.log("");
for (const f of failures) console.log(`  ✗ ${f}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
