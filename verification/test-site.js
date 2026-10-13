/**
 * "Collect the whole store": which links are categories, which sitemaps are
 * read, and that what reaches the planner is planned whole.
 *
 * The run itself goes through a real Chromium (verification/run.js, run W).
 * This covers the pure half of `extension/site.js`, and its seams with the
 * shipping server modules:
 *
 *   - a menu's links become the store's categories: its cart, account, help,
 *     blog and files are left out, so are the same categories in another
 *     language, and sort or filter variants are one category;
 *   - an index's children are ranked the way `rankChild` in sitemap.ts ranks
 *     them, and the extension reads every one of them, not the planner's ten;
 *   - a sitemap cut into pieces of at most `SWEEP_ENTRIES` addresses is
 *     planned whole: no product address is lost to the planner's 2,000 cap.
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
  else failures.push(`${name}\n     got  ${JSON.stringify(got).slice(0, 600)}\n     want ${JSON.stringify(want).slice(0, 600)}`);
}

const S = "https://shop.example";

(async () => {
  const site = await import(pathToFileURL(path.join(__dirname, "..", "extension", "site.js")).href);
  const pieces = await import(pathToFileURL(path.join(__dirname, "..", "extension", "sitemap-pieces.js")).href);
  const { planHtml } = await import(pathToFileURL(path.join(__dirname, "..", "extension", "listing.js")).href);

  // ── The language of an address ─────────────────────────────────────────────
  for (const [p, want] of [
    ["/", ""],
    ["/en", "/en"],
    ["/en/", "/en"],
    ["/en-us/men", "/en-us"],
    ["/en_GB/men/coats", "/en_gb"],
    ["/ua/en/man-jackets-l640.html", "/ua/en"],
    ["/ua/men/clothes/jackets-c1010193222.html", "/ua"],
    ["/c/coats", ""],
    ["/men/jackets", ""],
    ["/shopping/men/items.aspx", ""],
  ]) {
    check(`localePrefix(${p})`, site.localePrefix(p), want);
  }

  // ── One link as a category ─────────────────────────────────────────────────
  const start = `${S}/`;
  for (const [href, want] of [
    ["/c/coats", `${S}/c/coats`],
    ["/c/coats/", `${S}/c/coats/`],
    ["https://www.shop.example/c/coats", "https://www.shop.example/c/coats"],
    ["/c/coats#top", `${S}/c/coats`],
    ["/c/coats?utm_source=menu&sort=price&page=2", `${S}/c/coats`],
    ["/men/jackets-coats/cat/?cid=3606", `${S}/men/jackets-coats/cat/?cid=3606`],
    ["/ua/men/clothes/jackets-c1010193222.html", ""], // another language than the start page's
    ["/shopping/men/items.aspx", `${S}/shopping/men/items.aspx`],
    ["/c/coats?lang=fr", ""],
    ["/c/coats?country=DE", ""],
    ["/fr/c/coats", ""],
    ["/fr-fr/", ""],
    ["/cart", ""],
    ["/account/orders", ""],
    ["/help/returns", ""],
    ["/pages/about-us", ""],
    ["/blog/spring-edit", ""],
    ["/gift-cards", ""],
    ["/stores", ""],
    ["/lookbook.pdf", ""],
    ["/img/logo.png", ""],
    ["/", ""],
    ["/?utm_source=logo", ""],
    ["https://other.example/c/coats", ""],
    ["mailto:hello@shop.example", ""],
    ["javascript:void(0)", ""],
    ["tel:+380441234567", ""],
  ]) {
    check(`categoryAddress(${href})`, site.categoryAddress(href, start), want);
  }
  // The start page's language is the run's.
  const ua = `${S}/ua/`;
  check("in Ukrainian, a Ukrainian category", site.categoryAddress("/ua/men/clothes/jackets-c1010193222.html", ua), `${S}/ua/men/clothes/jackets-c1010193222.html`);
  check("in Ukrainian, not the English one", site.categoryAddress("/en/men/jackets", ua), "");
  check("in Ukrainian, not the unprefixed one", site.categoryAddress("/men/jackets", ua), "");
  const zara = `${S}/ua/en/`;
  check("country and language: the same pair", site.categoryAddress("/ua/en/man-jackets-l640.html", zara), `${S}/ua/en/man-jackets-l640.html`);
  check("country and language: not the same country in another", site.categoryAddress("/ua/uk/man-jackets-l640.html", zara), "");

  // ── The menu as a list of categories ───────────────────────────────────────
  const links = [
    { url: `${S}/`, label: "Home", where: "menu" },
    { url: `${S}/c/new`, label: "New in", where: "menu" },
    { url: `${S}/c/coats`, label: " Coats \n", where: "menu" },
    { url: `${S}/c/coats/`, label: "Coats again", where: "menu" },
    { url: `${S}/c/coats?sort=new`, label: "Newest coats", where: "menu" },
    { url: `${S}/fr/c/coats`, label: "Manteaux", where: "menu" },
    { url: `${S}/cart`, label: "Bag (0)", where: "menu" },
    { url: `${S}/account`, label: "Sign in", where: "menu" },
    { url: `${S}/c/knitwear`, label: "", where: "menu" },
    { url: `${S}/product/featured-coat`, label: "The coat of the season", where: "menu" },
    { url: `${S}/c/sale`, label: "Sale", where: "footer" },
    { url: `${S}/help`, label: "Help", where: "footer" },
    { url: `${S}/c/editorial-picks`, label: "Picks", where: "page" },
    { url: `${S}/product/coat-1`, label: "Coat 1", where: "page" },
  ];
  const cats = site.categoryCandidates(links, start);
  check(
    "the menu's categories, in its order, each once",
    cats.map((c) => c.url),
    [`${S}/c/new`, `${S}/c/coats`, `${S}/c/knitwear`, `${S}/product/featured-coat`, `${S}/c/sale`],
  );
  check("labels trimmed, and one made from the address when the link says nothing", cats.map((c) => c.label), [
    "New in",
    "Coats",
    "knitwear",
    "The coat of the season",
    "Sale",
  ]);
  check("where each was found", cats.map((c) => c.where), ["menu", "menu", "menu", "menu", "footer"]);
  check(
    "the start page is never one of them: the run walks it first anyway",
    site.categoryCandidates([{ url: `${S}/c/coats`, label: "Coats", where: "menu" }, ...links], `${S}/c/coats`).some(
      (c) => c.url === `${S}/c/coats`,
    ),
    false,
  );
  check(
    "a menu of fewer than three: the page's own links are read too",
    site.categoryCandidates(
      [
        { url: `${S}/c/men`, label: "Men", where: "menu" },
        { url: `${S}/c/women`, label: "Women", where: "page" },
        { url: `${S}/c/kids`, label: "Kids", where: "page" },
        { url: `${S}/about`, label: "About", where: "page" },
      ],
      start,
    ).map((c) => c.url),
    [`${S}/c/men`, `${S}/c/women`, `${S}/c/kids`],
  );
  check(
    "a cap on how many",
    site.categoryCandidates(
      Array.from({ length: 50 }, (_, i) => ({ url: `${S}/c/cat-${i}`, label: `Cat ${i}`, where: "menu" })),
      start,
      10,
    ).length,
    10,
  );
  check(
    "nothing usable: nothing",
    site.categoryCandidates([{ url: "http://[" }, null, { url: 42 }, { url: "https://other.example/c/coats" }, { url: `${S}/cart`, where: "menu" }], start),
    [],
  );
  check("a label from the address, past its language", site.labelFromPath(`${S}/en-us/men/jackets-coats`), "men · jackets coats");

  // ── An index's children, ranked as the server ranks them ──────────────────
  const childUrls = [
    `${S}/sitemap-pages.xml`,
    `${S}/sitemap-misc.xml`,
    `${S}/sitemap_products_1.xml?from=1&amp;to=5000`,
    `${S}/sitemap-blog.xml`,
    `${S}/sitemap_collections_1.xml`,
    `${S}/sitemap_products_2.xml`,
    `https://cdn.other.example/sitemap_products_9.xml`,
    `${S}/sitemap-marketing.xml`,
    `${S}/sitemap-brands.xml`,
    `${S}/sitemap_products_2.xml`,
  ];
  for (const u of childUrls) {
    check(`rankChild(${u}) agrees with sitemap.ts`, site.rankChild(u), sitemap.rankChild(u));
  }
  const index = `<?xml version="1.0"?><sitemapindex>${childUrls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join("")}</sitemapindex>`;
  check("an index: products first, then the rest, never pages, blog, collections or marketing, only this store, each once", site.sitemapChildren(index, "www.shop.example"), [
    `${S}/sitemap_products_1.xml?from=1&to=5000`,
    `${S}/sitemap_products_2.xml`,
    `${S}/sitemap-misc.xml`,
    `${S}/sitemap-brands.xml`,
  ]);
  const many = `<sitemapindex>${Array.from({ length: 60 }, (_, i) => `<sitemap><loc><![CDATA[${S}/sitemap_products_${i + 1}.xml]]></loc></sitemap>`).join("")}</sitemapindex>`;
  check("sixty product sitemaps: all sixty, where the planner names ten", site.sitemapChildren(many, "shop.example").length, 60);
  check("isSitemapIndex", [site.isSitemapIndex(index), site.isSitemapIndex("<urlset></urlset>")], [true, false]);

  // ── A big sitemap, planned whole ───────────────────────────────────────────
  const N = 5_200;
  const doc = `<?xml version="1.0"?>\n<urlset>\n${Array.from(
    { length: N },
    (_, i) => `<url><loc>${S}/product/coat-${i}</loc><image:image><image:title>Coat ${i}</image:title></image:image></url>`,
  ).join("\n")}\n<url><loc>${S}/about</loc></url>\n</urlset>`;
  const cut = pieces.sitemapPieces(`${S}/product-sitemap.xml`, doc, pieces.PLAN_SITEMAP_BUDGET, site.SWEEP_ENTRIES ?? 1500);
  const counts = cut.map((p) => (p.xml.match(/<loc>/g) || []).length);
  check("a piece holds at most the sweep's number of addresses", counts.every((n) => n <= 1500), true);
  check("and every address is in one of them", counts.reduce((a, b) => a + b, 0), N + 1);
  const planned = new Set();
  let capped = false;
  for (const piece of cut) {
    const plan = planCollection({ startUrl: `${S}/`, sitemaps: [{ url: piece.url, xml: piece.xml }], limit: 2000 });
    if (plan.urls.length >= 2000) capped = true;
    for (const u of plan.urls) planned.add(u);
  }
  check("no piece reaches the planner's cap", capped, false);
  check("the planner finds every product across the pieces", planned.size, N);
  const whole = planCollection({ startUrl: `${S}/`, sitemaps: [{ url: `${S}/product-sitemap.xml`, xml: doc }], limit: 2000 });
  check("where the whole document gives it only 2,000", whole.urls.length, 2000);
  check(
    "without a cap, pieces are cut by bytes alone, as before",
    pieces.sitemapPieces(`${S}/product-sitemap.xml`, doc).length,
    1,
  );

  // ── A walk's links, planned in chunks ──────────────────────────────────────
  const walked = [
    ...Array.from({ length: 30 }, (_, i) => `${S}/c/nav-${i}`),
    ...Array.from({ length: 2600 }, (_, i) => `${S}/product/knit-${i}`),
  ];
  const got = new Set();
  for (let i = 0; i < walked.length; i += site.PLAN_LINKS ?? 1500) {
    const chunk = walked.slice(i, i + (site.PLAN_LINKS ?? 1500));
    const plan = planCollection({ startUrl: `${S}/c/knitwear`, html: planHtml([], chunk), limit: 2000 });
    for (const u of plan.urls) got.add(u);
  }
  check("a walk of 2,600 pieces planned in chunks: all 2,600", got.size, 2600);

  // ── The store of what has been opened, without IndexedDB ───────────────────
  const seen = new site.SeenStore();
  await seen.add(`${S}/product/a`);
  check("fresh: what was not opened, each once, in order", await seen.fresh([`${S}/product/b`, `${S}/product/a`, `${S}/product/b`, `${S}/product/c`]), [
    `${S}/product/b`,
    `${S}/product/c`,
  ]);
  check("count", await seen.count(), 1);
  await seen.clear();
  check("clear", await seen.fresh([`${S}/product/a`]), [`${S}/product/a`]);

  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
})();
