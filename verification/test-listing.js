/**
 * "Collect this page": what the walked listing hands the planner, and the
 * robots.txt reading that decides which of its pages the extension may open.
 *
 * The walk itself runs in a real tab (verification/run.js, runs L and M). This
 * covers the two pieces of `extension/listing.js` that must agree with the
 * server, run against the shipping modules:
 *
 *   - `robotsRules` / `robotsAllows` give the answers `robots.ts` gives. The
 *     extension checks the listing's later pages itself, since they never
 *     reach the server, and a drift between the two would open a page the
 *     server would have refused.
 *   - `planHtml` is read by `planCollection` as the page would have been: the
 *     same pieces, in the order the page showed them, the page still known for
 *     a product page when it is one.
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
const robots = require(path.join(PARSER, "robots.js"));
const { planCollection } = require(path.join(PARSER, "plan-collection.js"));

let pass = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else failures.push(`${name}\n     got  ${JSON.stringify(got).slice(0, 400)}\n     want ${JSON.stringify(want).slice(0, 400)}`);
}

(async () => {
  const { robotsRules, robotsAllows, planHtml } = await import(
    pathToFileURL(path.join(__dirname, "..", "extension", "listing.js")).href
  );

  // ── robots.txt: the same answers as the server ─────────────────────────────
  const files = {
    plain: "User-agent: *\nDisallow: /checkout\nDisallow: /*?sort=\nAllow: /c/*?page=\nCrawl-delay: 2.5\n",
    tie: "User-agent: *\nDisallow: /c/\nAllow: /c/\n",
    dollar: "User-agent: *\nDisallow: /*.json$\nDisallow: /price$list\n",
    groups: "User-agent: Googlebot\nDisallow:\n\nUser-agent: Bingbot\nUser-agent: *\nDisallow: /search\nCrawl-delay: 1\n",
    others: "User-agent: Googlebot\nDisallow: /\n",
    empty: "User-agent: *\nDisallow:\n",
    html: "<!doctype html><html><body>Not found</body></html>",
    comments: "# hello\nUser-agent: * # everyone\nDisallow: /private # keep out\n",
    pages: "User-agent: *\nDisallow: /*?page=\nDisallow: /*&page=\n",
    farfetch: "User-agent: *\nDisallow: /*?*view=\nDisallow: /checkout/\nDisallow: /*/shopping/*/items.aspx?*page=\n",
  };
  const urls = [
    "https://shop.example/",
    "https://shop.example/checkout",
    "https://shop.example/checkout/cart",
    "https://shop.example/c/jackets",
    "https://shop.example/c/jackets?page=2",
    "https://shop.example/c/jackets?sort=price&page=2",
    "https://shop.example/c/jackets?colour=black&page=3",
    "https://shop.example/products/coat.json",
    "https://shop.example/products/coat.json?x=1",
    "https://shop.example/price$list",
    "https://shop.example/price$listing",
    "https://shop.example/search?q=coat",
    "https://shop.example/private/a",
    "https://www.farfetch.com/lt/shopping/men/shoes-2/items.aspx",
    "https://www.farfetch.com/lt/shopping/men/shoes-2/items.aspx?page=2",
    "https://www.farfetch.com/lt/shopping/men/shoes-2/items.aspx?view=90&page=2",
    "not a url",
  ];
  for (const [name, text] of Object.entries(files)) {
    const ours = robotsRules(text);
    const theirs = robots.parseRobots(text);
    check(`robots "${name}": the same rules`, { allow: ours.allow, disallow: ours.disallow }, { allow: theirs.allow, disallow: theirs.disallow });
    check(`robots "${name}": the same pace`, ours.crawlDelayMs, theirs.crawlDelayMs);
    check(
      `robots "${name}": the same answer for every address`,
      urls.map((u) => robotsAllows(ours, u)),
      urls.map((u) => robots.isUrlAllowed(theirs, u)),
    );
  }
  check("a store that forbids paging is not paged", robotsAllows(robotsRules(files.pages), "https://shop.example/c/jackets?page=2"), false);
  check("one that does not, is", robotsAllows(robotsRules(files.plain), "https://shop.example/c/jackets?page=2"), true);

  // ── What the planner is sent ────────────────────────────────────────────────
  const START = "https://shop.example/c/jackets";
  const links = [
    "https://shop.example/",
    "https://shop.example/c/shoes",
    ...Array.from({ length: 40 }, (_, i) => `https://shop.example/products/jacket-${i + 1}`),
    "https://shop.example/products/jacket-3?color=red",
    "https://shop.example/c/jackets?page=2",
    "https://shop.example/products/it's-a-coat",
    'https://shop.example/products/the-"best"-coat',
    "https://shop.example/help",
  ];
  {
    const html = planHtml([{ ld: [], ogType: "website" }], links);
    const plan = planCollection({ startUrl: START, html, limit: 2000 });
    const want = [
      ...Array.from({ length: 40 }, (_, i) => `https://shop.example/products/jacket-${i + 1}`),
      "https://shop.example/products/it%27s-a-coat",
      "https://shop.example/products/the-%22best%22-coat",
    ];
    check("the planner finds every piece among the links, in the page's order", plan.urls, want);
    check("a category is not taken for a product", plan.isSingleProduct, false);
    const asPage = `<!doctype html><html><body>${links.map((u) => `<a href="${u.replace(/"/g, "&quot;")}">x</a>`).join("")}</body></html>`;
    const fromPage = planCollection({ startUrl: START, html: asPage, limit: 2000 });
    const plain = (list) => list.filter((u) => /\/jacket-\d+$/.test(u));
    check("the same pieces as from markup that held the same links", plain(plan.urls), plain(fromPage.urls));
    // Read from markup, the planner cuts `it's-a-coat` at the quote; sent this
    // way it arrives whole.
    check("an address with a quote in it arrives whole", plan.urls.filter((u) => /%2[27]/.test(u)).length, 2);
  }
  {
    // A product page: the planner still knows it for one by its page type, and
    // the run then takes only the piece itself.
    const html = planHtml([{ ld: [], ogType: "product" }], ["https://shop.example/products/other-1", "https://shop.example/products/other-2"]);
    const plan = planCollection({ startUrl: "https://shop.example/en/coat-red", html, limit: 2000 });
    check("a product page is still a product page", plan.isSingleProduct, true);
    check("and comes first", plan.urls[0], "https://shop.example/en/coat-red");
  }
  {
    // Structured data naming the category's items, kept from the walk.
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [
        { "@type": "ListItem", position: 1, item: { "@type": "Product", name: "A", url: "https://shop.example/products/from-data-1" } },
        { "@type": "ListItem", position: 2, item: { "@type": "Product", name: "B", url: "https://shop.example/products/from-data-2" } },
      ],
    });
    const html = planHtml([{ ld: [ld], ogType: "" }], ["https://shop.example/products/jacket-1"]);
    const plan = planCollection({ startUrl: START, html, limit: 2000 });
    check(
      "a listing's structured data still names its items",
      plan.urls,
      ["https://shop.example/products/from-data-1", "https://shop.example/products/from-data-2", "https://shop.example/products/jacket-1"],
    );
    const hostile = planHtml([{ ld: ['{"x":"</script><a href=\\"https://shop.example/products/injected\\">"}'], ogType: "" }], []);
    check("structured data cannot close its own script tag", /<\/script><a/.test(hostile), false);
  }
  {
    // A long walk is still one plan request the route takes.
    const many = Array.from({ length: 15_000 }, (_, i) => `https://www.farfetch.com/lt/shopping/men/a-long-name-of-a-piece-${i}-item-${20_000_000 + i}.aspx`);
    const html = planHtml([{ ld: ["x".repeat(500_000)], ogType: "" }], many);
    check("15,000 links and the kept structured data stay under the route's 3 MB", html.length < 3_000_000, true);
  }

  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
