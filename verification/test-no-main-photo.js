/**
 * No photo of the piece, no card.
 *
 * A GOAT page whose piece has no photo of its own came in as a card whose
 * photos were the pieces recommended under it. Nothing about this piece said
 * "this is my photo", so other places filled the gap:
 *
 * - with nothing in the page's markup to anchor to, the gallery harvester took
 *   any picture whose file name shared two words with the piece's name or
 *   address — a rail of the same model in other colours;
 * - the AI pass is allowed to add photos to a gallery below two, and asked for
 *   "every photo of this product" on a page that has none, it returned the
 *   rail; the first became the main photo;
 * - a placeholder ("no image", "missing") or the store's own share image in
 *   the markup stood as the main photo, and the rail was harvested beside it;
 * - and with a photo of its own, GOAT's `1111426_00.png.png` — two extensions
 *   — slipped past the `<code>_<frame>` rule, so the next product's
 *   `1111427_00.png.png` read as a frame of the same shoot.
 *
 * The rule now: the main photo is the page's own — its structured data,
 * OpenGraph, the store's product JSON — or there is none, and a page with no
 * photo is skipped (`collect/route.ts` takes a photoless page as links only).
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
const { parsePage } = require(path.join(PARSER, "parse-page.js"));
const { mergeAiIntoRaw } = require(path.join(PARSER, "ai-extract.js"));

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
/** A section that throws (a function the build does not have yet) fails as a whole, not the file. */
async function section(title, body) {
  console.log(`— ${title} —`);
  try {
    await body();
  } catch (err) {
    failures.push(`${title}: ${err && err.message}`);
  }
}

const PAGE = "https://www.goat.com/sneakers/air-jordan-1-retro-high-og-dz5485-612";
const NAME = "Air Jordan 1 Retro High OG 'Chicago Lost and Found'";
/** GOAT's CDN, the way its product pictures are addressed. */
const GOAT = (id, frame = "00") =>
  `https://image.goat.com/transform/v1/attachments/product_template_pictures/images/095/486/498/original/${id}_${frame}.png.png?action=crop&width=750`;
/** The rail under the piece: other sneakers, one of them the same model in another colour. */
const RAIL = [
  GOAT("1111426"),
  GOAT("1111427"),
  "https://image.goat.com/attachments/product_template_pictures/images/air-jordan-1-retro-high-og-chicago-reimagined.png",
];

const OPTS = {
  fetchSettings: { provider: "direct" },
  fetchApiKey: "",
  siteConfigs: [],
  aiSettings: { enabled: false, mode: "fallback" },
  useAi: false,
};

function goatPage({ ldImage, ogImage, gallery: own = [] } = {}) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: NAME,
    sku: "DZ5485 612",
    brand: { "@type": "Brand", name: "Air Jordan" },
    ...(ldImage ? { image: ldImage } : {}),
    offers: { "@type": "Offer", price: 215, priceCurrency: "USD" },
  };
  const html = `<html><head><title>${NAME} | GOAT</title>
    ${ogImage ? `<meta property="og:image" content="${ogImage}">` : ""}
    <script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>
    <h1>${NAME}</h1>
    <div class="css-1a2b3c">${own.map((u) => `<img src="${u}">`).join("")}</div>
    <div class="css-9z8y7x">${RAIL.map((u, i) => `<a href="/sneakers/other-${i}"><img src="${u}"></a>`).join("")}</div>
    </body></html>`;
  // What the extension sends: every picture the page shows, the rail's too —
  // its classes are generated, so it is not recognised as "you may also like".
  return { html, evidence: { images: [...own, ...RAIL], priceText: "$215", titleText: NAME } };
}

(async () => {
  await section("a placeholder or the store's share image is not a photo of the piece", () => {
    const no = gallery.isPlaceholderPhoto;
    for (const u of [
      "https://www.goat.com/images/placeholders/product.png",
      "https://image.goat.com/attachments/missing.png",
      "https://cdn.shop.example.com/files/no-image.jpg",
      "https://cdn.shop.example.com/files/image-not-available.png",
      "https://cdn.shop.example.com/files/coming-soon.jpg",
      "https://www.goat.com/images/og-image.png",
      "https://shop.example.com/static/store-logo.png",
    ]) ok(`not a photo: ${u.split("/").slice(-2).join("/")}`, no(u) === true);
    for (const u of [
      "https://cdn.shop.example.com/files/logo-tee-black-front.jpg",
      "https://cdn.shop.example.com/files/starter-jacket-1.jpg",
      "https://cdn.shop.example.com/files/default-cargo-pants-2.jpg",
      GOAT("1111400"),
      "https://res.cloudinary.com/ssenseweb/image/upload/__IMAGE_PARAMS__/252342M223005_1.jpg",
    ]) ok(`a photo: ${u.split("/").pop()}`, no(u) === false);
  });

  for (const [label, shape] of [
    ["nothing in the markup", {}],
    ["a placeholder in JSON-LD and OpenGraph", { ldImage: "https://www.goat.com/images/placeholders/product.png", ogImage: "https://www.goat.com/images/placeholders/product.png" }],
    ["the store's share image in OpenGraph", { ogImage: "https://www.goat.com/images/og-image.png" }],
  ]) {
    await section(`GOAT, no photo of the piece: ${label}`, async () => {
      const { html, evidence } = goatPage(shape);
      const result = await parsePage(PAGE, { ...OPTS, html, evidence });
      const p = result.products[0];
      ok("still read as the piece (name and price)", !!p && p.name.includes("Chicago") && p.price === 215, JSON.stringify(p && { name: p.name, price: p.price }));
      if (!p) return;
      check("no main photo", p.imageUrl, "");
      check("no photos at all — not the rail's", p.images, []);
    });
  }

  await section("GOAT, with a photo of its own: the next product numbers are not its frames", async () => {
    const own = [GOAT("1111400"), GOAT("1111400", "01"), GOAT("1111400", "02")];
    const { html, evidence } = goatPage({ ldImage: own[0], gallery: own });
    const result = await parsePage(PAGE, { ...OPTS, html, evidence });
    const p = result.products[0];
    ok("read as the piece", !!p);
    if (!p) return;
    const ids = p.images.map((u) => (u.match(/\/(\d{7})_(\d\d)\./) ?? []).slice(1).join("_"));
    check("its three frames and nothing else", ids, ["1111400_00", "1111400_01", "1111400_02"]);
    ok("each a whole address, `.png.png` and all", p.images.every((u) => /\.png\.png/.test(u)), JSON.stringify(p.images));
  });

  await section("AI never brings the main photo, and adds only the piece's own frames", () => {
    const none = mergeAiIntoRaw(
      { name: NAME, price: "215", images: [], strategies: [] },
      { images: RAIL },
      PAGE,
    );
    check("no photo of its own: AI adds none", none.raw.images, []);
    ok("and no main photo from AI", !none.raw.image, none.raw.image);
    ok("images not reported as filled", !none.used.includes("images"), JSON.stringify(none.used));

    const own = mergeAiIntoRaw(
      { name: NAME, price: "215", image: GOAT("1111400"), images: [GOAT("1111400")], strategies: [] },
      { images: [GOAT("1111400", "01"), ...RAIL, "https://ads.example.net/banner.jpg"] },
      PAGE,
    );
    const frames = (list) => list.map((u) => (u.match(/\/(\d{7}_\d\d)\./) ?? [])[1] ?? u);
    check("beside its own photo: its next frame, not the rail", frames(own.raw.images), ["1111400_00", "1111400_01"]);
    check("the main photo stays its own", own.raw.image, GOAT("1111400"));
  });

  console.log("");
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
