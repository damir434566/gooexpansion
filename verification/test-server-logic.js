/**
 * Exercises the real compiled robots.ts and plan-collection.ts.
 * Not a fixture of them — the actual modules the route imports.
 */
const path = require("path");
const Module = require("module");

// Resolve the project's "@/..." alias to the compiled tree, the way the bundler
// does in the app.
const COMPILED = path.join(__dirname, "compiled");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(COMPILED, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

const DIR = path.join(__dirname, "compiled", "lib", "server", "parser");
const { parseRobots, isPathAllowed, isUrlAllowed } = require(path.join(DIR, "robots.js"));
const { planCollection, MIN_DELAY_MS } = require(path.join(DIR, "plan-collection.js"));

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
  }
}

// ── robots.ts ────────────────────────────────────────────────────────────────

const ROBOTS = `
# a store that wants its catalogue indexed and nothing else
User-agent: Googlebot
Disallow:
Crawl-delay: 0.1

User-agent: *
Disallow: /
Allow: /product/
Disallow: /product/secret-
Crawl-delay: 2.5

Sitemap: https://shop.test/sitemap.xml
`;

const r = parseRobots(ROBOTS);

check("only the * group is read (Googlebot's empty Disallow ignored)", r.disallow, [
  "/",
  "/product/secret-",
]);
check("allow list from the * group", r.allow, ["/product/"]);
check("crawl-delay is the * group's, in ms, fractional ok", r.crawlDelayMs, 2500);
check("sitemap collected", r.sitemaps, ["https://shop.test/sitemap.xml"]);
check("parsed flag set", r.parsed, true);

check("longest match: /product/ beats Disallow: /", isPathAllowed(r, "/product/coat"), true);
check("longest match: the more specific Disallow wins", isPathAllowed(r, "/product/secret-x"), false);
check("Disallow: / blocks everything else", isPathAllowed(r, "/about"), false);
check("root itself is blocked", isPathAllowed(r, "/"), false);

// Tie goes to Allow.
const tie = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a");
check("equal-length patterns: Allow wins", isPathAllowed(tie, "/a/b"), true);

// Empty Disallow means nothing is forbidden.
const empty = parseRobots("User-agent: *\nDisallow:");
check("empty Disallow forbids nothing", isPathAllowed(empty, "/anything"), true);
check("empty Disallow is not a pattern", empty.disallow, []);

// Wildcards and the end anchor.
const wild = parseRobots("User-agent: *\nDisallow: /*.php$\nDisallow: /tmp/*/private");
check("wildcard + $ anchor matches", isPathAllowed(wild, "/index.php"), false);
check("$ anchor does not match past the end", isPathAllowed(wild, "/index.php?x=1"), true);
check("mid-pattern wildcard", isPathAllowed(wild, "/tmp/a/private"), false);
check("literal dot is not a regex dot", isPathAllowed(wild, "/indexXphp"), true);

// Grouped agents share one block.
const grouped = parseRobots("User-agent: Googlebot\nUser-agent: *\nDisallow: /x");
check("a * sharing a group with another agent still applies", isPathAllowed(grouped, "/x"), false);

// A new User-agent after rules starts a new group.
const regroup = parseRobots("User-agent: *\nDisallow: /a\n\nUser-agent: Bing\nDisallow: /b");
check("rules after a new agent are not ours", regroup.disallow, ["/a"]);

// Comments and junk.
const commented = parseRobots("User-agent: * # everyone\nDisallow: /priv # secret\n");
check("comments stripped from values", commented.disallow, ["/priv"]);

// A 404 page instead of robots.txt.
const html = parseRobots("<!doctype html><html><body>Not found</body></html>");
check("an HTML body is not a parsed robots.txt", html.parsed, false);
check("an HTML body forbids nothing", isPathAllowed(html, "/product/x"), true);

// Absent file.
check("absent robots.txt forbids nothing", isPathAllowed(parseRobots(""), "/x"), true);
check("malformed URL is refused, not assumed safe", isUrlAllowed(r, "not a url"), false);
check("isUrlAllowed reads the path", isUrlAllowed(r, "https://shop.test/product/coat"), true);

// ── plan-collection.ts ───────────────────────────────────────────────────────

const sitemapXml = `<?xml version="1.0"?>
<urlset>
  <loc>https://shop.test/product/alpha</loc>
  <loc>https://shop.test/product/beta</loc>
  <loc>https://shop.test/product/secret-gamma</loc>
  <loc>https://shop.test/about</loc>
  <loc>https://elsewhere.test/product/delta</loc>
</urlset>`;

const plan = planCollection({
  startUrl: "https://shop.test/collections/all",
  robotsTxt: ROBOTS,
  sitemaps: [{ url: "https://shop.test/sitemap.xml", xml: sitemapXml }],
  limit: 50,
});

check("products taken from the sitemap", plan.urls, [
  "https://shop.test/product/alpha",
  "https://shop.test/product/beta",
]);
check("robots-disallowed product counted, not returned", plan.robots.blocked, 1);
check("pace is the store's crawl-delay when it is slower than our floor", plan.delayMs, 2500);
check("non-product and off-host entries dropped", plan.locsSeen, 5);

// Our floor applies when the store asks for nothing.
const noDelay = planCollection({
  startUrl: "https://shop.test/c",
  robotsTxt: "User-agent: *\nDisallow:",
  sitemaps: [{ url: "https://shop.test/s.xml", xml: sitemapXml }],
  limit: 50,
});
check("floor applies when no crawl-delay is given", noDelay.delayMs, MIN_DELAY_MS);
check("floor is 1.5s", MIN_DELAY_MS, 1500);

// A store that asks for something faster than our floor does not get it.
const fast = planCollection({
  startUrl: "https://shop.test/c",
  robotsTxt: "User-agent: *\nCrawl-delay: 0.2",
  sitemaps: [{ url: "https://shop.test/s.xml", xml: sitemapXml }],
  limit: 50,
});
check("a crawl-delay faster than our floor is raised to it", fast.delayMs, MIN_DELAY_MS);

// A sitemap index yields children to fetch next, not products.
const indexPlan = planCollection({
  startUrl: "https://shop.test/c",
  sitemaps: [
    {
      url: "https://shop.test/sitemap.xml",
      xml: `<?xml version="1.0"?><sitemapindex>
        <loc>https://shop.test/product-sitemap.xml</loc>
        <loc>https://shop.test/blog-sitemap.xml</loc>
      </sitemapindex>`,
    },
  ],
  limit: 50,
});
check("index yields no products", indexPlan.urls, []);
check("blog child ranked out, product child kept", indexPlan.fetchNext, [
  "https://shop.test/product-sitemap.xml",
]);

// Already-seen addresses are not planned twice.
const dedup = planCollection({
  startUrl: "https://shop.test/c",
  robotsTxt: "User-agent: *\nDisallow:",
  sitemaps: [{ url: "https://shop.test/s.xml", xml: sitemapXml }],
  seen: ["https://shop.test/product/alpha"],
  limit: 50,
});
check("seen addresses are skipped", dedup.urls, [
  "https://shop.test/product/beta",
  "https://shop.test/product/secret-gamma",
]);

// Anchors on the rendered page count too.
const fromHtml = planCollection({
  startUrl: "https://shop.test/collections/all",
  robotsTxt: "User-agent: *\nDisallow:",
  html: `<a href="/product/from-page">x</a><a href="/about">y</a>`,
  limit: 50,
});
check("anchors on the page contribute", fromHtml.urls, ["https://shop.test/product/from-page"]);

// With nothing read yet, the conventional sitemap names are proposed.
const seeded = planCollection({ startUrl: "https://shop.test/c", limit: 10 });
check(
  "conventional sitemap names proposed on the first round",
  seeded.fetchNext.slice(0, 2),
  ["https://shop.test/sitemap.xml", "https://shop.test/sitemap_index.xml"],
);

// The limit is honoured.
const capped = planCollection({
  startUrl: "https://shop.test/c",
  robotsTxt: "User-agent: *\nDisallow:",
  sitemaps: [{ url: "https://shop.test/s.xml", xml: sitemapXml }],
  limit: 1,
});
check("limit caps the plan", capped.urls.length, 1);

// A product address pasted directly is a one-item run.
const single = planCollection({ startUrl: "https://shop.test/product/solo", limit: 10 });
check("a pasted product page is recognised", single.isSingleProduct, true);
check("and is itself planned", single.urls, ["https://shop.test/product/solo"]);

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach((f) => console.log("  FAIL " + f + "\n"));
  process.exit(1);
}
