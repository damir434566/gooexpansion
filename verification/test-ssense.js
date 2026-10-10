/**
 * SSENSE: the main photo, and one photo per shot.
 *
 * A run on SSENSE made cards whose main photo was a broken image, and whose
 * gallery held the same shot two and three times up to the 20-photo ceiling.
 *
 * - The main photo is a template. SSENSE's JSON-LD names it
 *   `res.cloudinary.com/ssenseweb/image/upload/__IMAGE_PARAMS__/<id>_1.jpg`,
 *   a blank its script fills in; the CDN has no such picture. Structured data
 *   is trusted first, so the blank became the card's main photo, the server
 *   could not download it ("95 photos copied" for five cards of twenty), and
 *   the address was kept on the card as it stood.
 * - Cloudinary renditions read as different photos: `…/w_470,dpr_1.0/<id>_1…`
 *   and `…/dpr_2.0/<id>_1…` are one upload. And split on every comma, a
 *   srcset of them came apart into `…/images/b_white`, `c_lpad`, ….
 *
 * Runs against the real modules in `verification/compiled` (./compile.sh).
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
const gallery = require(path.join(PARSER, "gallery.js"));
const { imageKey, harvestGalleryImages } = gallery;
const { normalizeExtract } = require(path.join(PARSER, "normalize.js"));
const { parsePage } = require(path.join(PARSER, "parse-page.js"));

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
};
const ok = (name, condition, detail = "") => {
  if (condition) pass++;
  else failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
};

const PAGE = "https://www.ssense.com/en-gb/men/product/balenciaga/black-venom-boots/18128871";
const ID = "252342M223005";
const TEMPLATE = (n) => `https://res.cloudinary.com/ssenseweb/image/upload/__IMAGE_PARAMS__/${ID}_${n}.jpg`;
/** What SSENSE's own pages render, on its own domain with an SEO name. */
const SHOWN = (n, chain = "b_white,g_center,f_auto,q_auto:best") =>
  `https://img.ssensemedia.com/images/${chain}/${ID}_${n}/balenciaga-black-venom-boots.jpg`;
const SLIDE = "b_white,c_lpad,g_center,h_706,w_470/c_scale,h_680/f_auto,dpr_1.0";
const SLIDE_2X = "b_white,c_lpad,g_center,h_706,w_470/c_scale,h_680/f_auto,dpr_2.0";
/** The same, as `res.cloudinary.com` spells it — the other way the page may render. */
const UPLOAD = (n, chain = SLIDE) => `https://res.cloudinary.com/ssenseweb/image/upload/${chain}/${ID}_${n}.jpg`;
/** Another product, on the same CDN, in "you may also like". */
const OTHER = `https://img.ssensemedia.com/images/${SLIDE}/251342M237001_1/balenciaga-black-venom-sneakers.jpg`;

/** A section that throws (a function the build does not have yet) fails as a whole, not the file. */
function section(title, body) {
  console.log(`— ${title} —`);
  try {
    body();
  } catch (err) {
    failures.push(`${title}: ${err && err.message}`);
  }
}

const blank = (u) => /__IMAGE_PARAMS__|%7B|\{/i.test(u);
/** Which shot an address is, by SSENSE's numbering. */
const shot = (u) => (u.match(/_(\d)(?:\/|\.jpg)/) ?? [])[1];

section("one upload is one photo, whatever its rendition", () => {
  const keys = [TEMPLATE(1), SHOWN(1), SHOWN(1, SLIDE), SHOWN(1, SLIDE_2X), UPLOAD(1), UPLOAD(1, SLIDE_2X)].map(imageKey);
  check("six addresses of shot 1, one key", new Set(keys).size, 1);
  ok("shot 2 is another photo", imageKey(SHOWN(2)) !== imageKey(SHOWN(1)));
  ok("another product is another photo", imageKey(OTHER) !== imageKey(SHOWN(1)));
  ok(
    "another account with the same file name is another photo",
    imageKey(`https://res.cloudinary.com/otherstore/image/upload/w_400/${ID}_1.jpg`) !== imageKey(UPLOAD(1)),
  );
  check(
    "a version segment is not the photo",
    imageKey("https://res.cloudinary.com/acme/image/upload/v1612345678/coats/wool-1.jpg"),
    imageKey("https://res.cloudinary.com/acme/image/upload/w_600,f_auto/coats/wool-1.webp"),
  );
  ok(
    "an ordinary /images/ folder is not read as Cloudinary",
    imageKey("https://shop.example.com/images/coat-1.jpg") !== imageKey("https://shop.example.com/images/coat-2.jpg"),
  );
});

section("the better copy of a photo", () => {
  const rank = gallery.renditionRank;
  ok("a template is worse than any rendition", rank(TEMPLATE(1)) < rank(UPLOAD(1)));
  ok("2× beats 1×", rank(SHOWN(1, SLIDE_2X)) > rank(SHOWN(1, SLIDE)));
  ok("a chain with no size is the full upload", rank(SHOWN(1)) > rank(SHOWN(1, SLIDE_2X)));
  check("no opinion outside Cloudinary", rank("https://cdn.shop.example.com/files/coat-1.jpg"), 0);
});

section("srcset with commas inside its addresses", () => {
  check(
    "two Cloudinary renditions stay whole",
    gallery.srcsetUrls(`${SHOWN(1, SLIDE)} 1x, ${SHOWN(1, SLIDE_2X)} 2x`),
    [SHOWN(1, SLIDE), SHOWN(1, SLIDE_2X)],
  );
  check(
    "an ordinary srcset is read as before",
    gallery.srcsetUrls("/a_300.jpg 300w,/a_600.jpg 600w, /a_900.jpg 900w"),
    ["/a_300.jpg", "/a_600.jpg", "/a_900.jpg"],
  );
  check("a lone address with no descriptor", gallery.srcsetUrls(SHOWN(2)), [SHOWN(2)]);
  check("an address the comma closes, with no descriptor", gallery.srcsetUrls("/a.jpg, /b.jpg 2x"), ["/a.jpg", "/b.jpg"]);
});

section("a template takes the page's own address for its photo", () => {
  const p = normalizeExtract(
    { name: "Black Venom Boots", image: TEMPLATE(1), images: [TEMPLATE(1), SHOWN(1, SLIDE), SHOWN(1), SHOWN(2, SLIDE)], strategies: [] },
    PAGE,
    null,
  );
  check("main photo is the biggest copy the page rendered", p.imageUrl, SHOWN(1));
  check("two photos", p.images, [SHOWN(1), SHOWN(2, SLIDE)]);
});

section("a template no rendered copy replaced", () => {
  // The page rendered shot 3 and nothing else: the blanks of 1 and 2 take the
  // chain the account demonstrably serves.
  const p = normalizeExtract(
    { name: "Black Venom Boots", image: TEMPLATE(1), images: [TEMPLATE(1), TEMPLATE(2), UPLOAD(3)], strategies: [] },
    PAGE,
    null,
  );
  check("main photo filled from its sibling's chain", p.imageUrl, UPLOAD(1));
  check("every photo an address", p.images, [UPLOAD(1), UPLOAD(2), UPLOAD(3)]);
});

section("a template alone", () => {
  const p = normalizeExtract({ name: "Black Venom Boots", image: TEMPLATE(1), images: [TEMPLATE(1)], strategies: [] }, PAGE, null);
  check(
    "no sibling: the blank is dropped and the upload itself asked for",
    p.imageUrl,
    `https://res.cloudinary.com/ssenseweb/image/upload/${ID}_1.jpg`,
  );
});

section("a blank outside Cloudinary", () => {
  const p = normalizeExtract(
    {
      name: "Coat",
      image: "https://cdn.shop.example.com/{size}/coat-1.jpg",
      images: ["https://cdn.shop.example.com/{size}/coat-1.jpg", "https://cdn.shop.example.com/files/coat-2.jpg"],
      strategies: [],
    },
    "https://shop.example.com/products/coat",
    null,
  );
  check("a blank nothing can fill is no photo", p.images, ["https://cdn.shop.example.com/files/coat-2.jpg"]);
  check("and is not the main photo", p.imageUrl, "https://cdn.shop.example.com/files/coat-2.jpg");
});

section("Shopify's lazy-loading blank", () => {
  const p = normalizeExtract(
    {
      name: "Tee",
      image: "https://cdn.shopify.com/s/files/1/0001/files/tee_{width}x.jpg",
      images: ["https://cdn.shopify.com/s/files/1/0001/files/tee_{width}x.jpg", "https://cdn.shopify.com/s/files/1/0001/files/tee.jpg"],
      strategies: [],
    },
    "https://shop.example.com/products/tee",
    null,
  );
  check("Shopify's {width} blank is its original", p.images, ["https://cdn.shopify.com/s/files/1/0001/files/tee.jpg"]);
});

section("the gallery offers the rendered copy of a trusted template", () => {
  const out = harvestGalleryImages("<html></html>", PAGE, [TEMPLATE(1)], "Black Venom Boots", [SHOWN(1, SLIDE), SHOWN(2, SLIDE), OTHER]);
  check("shot 1's address and shot 2, not the other product", out, [SHOWN(1, SLIDE), SHOWN(2, SLIDE)]);
});

/** A product page the way SSENSE builds one, as the extension sends it. */
function ssensePage(render) {
  const ld = {
    "@context": "http://schema.org/",
    "@type": "Product",
    name: "Black Venom Boots",
    productID: 18128871,
    sku: ID,
    brand: { "@type": "Brand", name: "Balenciaga" },
    description: "Buffed leather ankle-high boots in black.",
    image: TEMPLATE(1),
    url: PAGE,
    offers: { "@type": "Offer", price: 1695, priceCurrency: "GBP", availability: "https://schema.org/InStock", url: PAGE },
  };
  const slide = (n) =>
    `<picture><source srcset="${render(n, SLIDE)} 1x, ${render(n, SLIDE_2X)} 2x"><img src="${render(n, SLIDE)}" alt="Balenciaga - Black Venom Boots - ${n}"></picture>`;
  const html = `<html><head>
    <title>Balenciaga - Black Venom Boots | SSENSE UK</title>
    <script type="application/ld+json">${JSON.stringify(ld)}</script>
    </head><body>
    <h1>Black Venom Boots</h1>
    <div class="pdp-gallery">${[1, 2, 3].map(slide).join("")}</div>
    <section class="related"><a href="/en-gb/men/product/balenciaga/black-venom-sneakers/18128900"><img src="${OTHER}"></a></section>
    </body></html>`;
  // What `collectImages` in an extension up to 1.0.18 sent: currentSrc, then
  // the srcset split on every comma — fragments included — then every image
  // address in the scripts it strips, where the slides not yet mounted live
  // as templates.
  const naive = (v) => v.split(",").map((part) => part.trim().split(/\s+/)[0]);
  const images = [
    ...[1, 2, 3].flatMap((n) => [render(n, SLIDE_2X), ...naive(`${render(n, SLIDE)} 1x, ${render(n, SLIDE_2X)} 2x`)]),
    ...[1, 2, 3, 4].map(TEMPLATE),
  ]
    .map((u) => {
      try {
        return new URL(u, PAGE).href;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { html, evidence: { images, priceText: "£1,695", titleText: "Black Venom Boots", brandText: "Balenciaga" } };
}

const OPTS = {
  fetchSettings: { provider: "direct" },
  fetchApiKey: "",
  siteConfigs: [],
  aiSettings: { enabled: false, mode: "fallback" },
  useAi: false,
};

(async () => {
  for (const [label, render] of [
    ["rendered on img.ssensemedia.com", (n, chain) => SHOWN(n, chain)],
    ["rendered on res.cloudinary.com", (n, chain) => UPLOAD(n, chain)],
  ]) {
    console.log(`— the whole page, ${label} —`);
    const { html, evidence } = ssensePage(render);
    const result = await parsePage(PAGE, { ...OPTS, html, evidence });
    const p = result.products[0];
    ok("read as one product", !result.isListing && !!p, JSON.stringify(result.products.map((x) => x.name)));
    if (!p) continue;
    ok("main photo is an address, not a template", !blank(p.imageUrl), p.imageUrl);
    check("main photo is shot 1", shot(p.imageUrl), "1");
    ok("main photo is one the page rendered", p.imageUrl === render(1, SLIDE_2X), p.imageUrl);
    check("one photo per shot, in order", p.images.map(shot), ["1", "2", "3", "4"]);
    ok("no template in the gallery", !p.images.some(blank), JSON.stringify(p.images));
    ok("no other product", !p.images.some((u) => u.includes("251342M237001")), JSON.stringify(p.images));
    ok("no srcset fragment", p.images.every((u) => /\.jpg$/.test(u)), JSON.stringify(p.images));
    ok("main photo first in the gallery", p.images[0] === p.imageUrl, JSON.stringify(p.images));
  }

  // The second SSENSE run (Saucony, BAPE): the gallery held a dozen copies of
  // one shot and photos of OTHER sneakers. SSENSE codes begin with the season,
  // the brand and the category, so every Saucony sneaker of a season starts
  // `251149M237`, and the rail under the piece (its classes are generated, the
  // extension cannot tell it is a rail) is the same brand's other sneakers.
  // Ten characters in common read as "a numbered frame of the same shoot".
  const CODE = "251149M237012";
  const RAIL = ["251149M237015", "251149M237009", "251149M237013"];
  const SNEAKER = "https://www.ssense.com/en-gb/men/product/saucony/white-progrid-ride-1-sneakers/17654321";
  const WIDTHS = [200, 300, 400, 500, 600, 800, 1000, 1200, 1400, 1600];
  for (const [label, at] of [
    ["img.ssensemedia.com", (code, n, chain, slug = "saucony-white-progrid-ride-1-sneakers") =>
      `https://img.ssensemedia.com/images/${chain}/${code}_${n}/${slug}.jpg`],
    ["res.cloudinary.com", (code, n, chain) => `https://res.cloudinary.com/ssenseweb/image/upload/${chain}/${code}_${n}.jpg`],
  ]) {
    console.log(`— Saucony: a dozen widths a shot and the brand's other sneakers beside it, on ${label} —`);
    const chain = (w) => `b_white,c_pad,g_center,w_${w}/f_auto,q_auto`;
    const srcset = (code, n, slug) => WIDTHS.map((w) => `${at(code, n, chain(w), slug)} ${w}w`).join(", ");
    const ld = {
      "@context": "http://schema.org/",
      "@type": "Product",
      name: "White ProGrid Ride 1 Sneakers",
      sku: CODE,
      brand: { "@type": "Brand", name: "Saucony" },
      image: `https://res.cloudinary.com/ssenseweb/image/upload/__IMAGE_PARAMS__/${CODE}_1.jpg`,
      offers: { "@type": "Offer", price: 140, priceCurrency: "GBP" },
    };
    const shots = [1, 2, 3, 4, 5];
    const html = `<html><head><title>Saucony - White ProGrid Ride 1 Sneakers | SSENSE UK</title>
      <script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>
      <h1>White ProGrid Ride 1 Sneakers</h1>
      <div class="css-8k2x1q">${shots.map((n) => `<img src="${at(CODE, n, chain(600))}" srcset="${srcset(CODE, n)}">`).join("")}</div>
      <div class="css-19fjz3">${RAIL.map((c, i) =>
        `<a href="/en-gb/men/product/saucony/white-progrid-omni-9-sneakers/1765${i}"><img src="${at(c, 1, chain(400), "saucony-white-progrid-omni-9-sneakers")}" srcset="${srcset(c, 1, "saucony-white-progrid-omni-9-sneakers")}"></a>`).join("")}</div>
      </body></html>`;
    // The extension sends every picture the page shows: the rail's too.
    const images = [
      ...shots.flatMap((n) => WIDTHS.map((w) => at(CODE, n, chain(w)))),
      ...RAIL.flatMap((c) => WIDTHS.map((w) => at(c, 1, chain(w), "saucony-white-progrid-omni-9-sneakers"))),
    ];
    const result = await parsePage(SNEAKER, { ...OPTS, html, evidence: { images, priceText: "£140", titleText: "White ProGrid Ride 1 Sneakers" } });
    const p = result.products[0];
    ok("read as one product", !result.isListing && !!p);
    if (!p) continue;
    const codeOf = (u) => (u.match(/(\d{6}M\d{6})_(\d)/) ?? [])[1];
    const frameOf = (u) => (u.match(/\d{6}M\d{6}_(\d)/) ?? [])[1];
    check("only this sneaker's photos", [...new Set(p.images.map(codeOf))], [CODE]);
    check("each shot once, in order", p.images.map(frameOf), ["1", "2", "3", "4", "5"]);
    ok("each the biggest width the page offered", p.images.every((u) => u.includes("w_1600")), JSON.stringify(p.images));
    check("main photo is shot 1", frameOf(p.imageUrl), "1");
    ok("main photo is an address, not a template", !blank(p.imageUrl), p.imageUrl);
  }

  console.log("");
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
