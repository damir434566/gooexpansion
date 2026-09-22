/**
 * The three things this round was asked to fix, against the real modules.
 *
 *   1. every photo on the page, not the two a carousel had mounted
 *   2. a price in hryvnia, złoty or roubles stated in dollars, not relabelled
 *   3. Farfetch specifically: why it gave fewer photos than anyone else
 *
 * Nothing here is a fixture of the shipping code — `verification/compiled` is
 * the shipping code, built by compile.sh. The Farfetch case is reproduced from
 * the shape of the page rather than from the site: a single-page storefront
 * keeps its gallery in the hydration payload, and the extension deletes scripts
 * before sending. That deletion is the bug, and it is reproducible without ever
 * asking farfetch.com for anything.
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
const { extractProduct } = require(path.join(PARSER, "extract.js"));
const { normalizeExtract } = require(path.join(PARSER, "normalize.js"));
const { harvestGalleryImages } = require(path.join(PARSER, "gallery.js"));
const { extractCurrencyFromDisplay, MAX_PRODUCT_IMAGES } = require(
  path.join(COMPILED, "lib", "server", "product-fields.js"),
);
const { productToDb, dbToProduct } = require(path.join(COMPILED, "lib", "data", "db.js"));
const { writeRowDroppingUnknown } = require(path.join(COMPILED, "lib", "server", "write-row.js"));

const FX_PATH = path.join(COMPILED, "lib", "server", "fx.js");

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

function ok(name, condition, detail = "") {
  if (condition) pass++;
  else failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
}

// ── 1. Currency out of a price a shopper reads ────────────────────────────────

console.log("— currency from the rendered price —");

check("pound", extractCurrencyFromDisplay("£49.99"), "GBP");
check("euro, comma decimal", extractCurrencyFromDisplay("€39,00"), "EUR");
check("hryvnia symbol", extractCurrencyFromDisplay("4 000 ₴"), "UAH");
check("hryvnia word", extractCurrencyFromDisplay("4 000 грн"), "UAH");
check("rouble symbol", extractCurrencyFromDisplay("12 990 ₽"), "RUB");
check("rouble word", extractCurrencyFromDisplay("12 990 руб."), "RUB");
check("zloty", extractCurrencyFromDisplay("1 299 zł"), "PLN");
check("koruna", extractCurrencyFromDisplay("1 290 Kč"), "CZK");
check("plain dollar", extractCurrencyFromDisplay("$1,290"), "USD");
// The regression the lookbehind exists for: the "S$" inside "US$" is not the
// Singapore dollar, and the "A$" inside a word is not the Australian one.
check("US dollar spelled out", extractCurrencyFromDisplay("US$ 1,290"), "USD");
check("Singapore dollar", extractCurrencyFromDisplay("S$ 120"), "SGD");
check("Canadian dollar", extractCurrencyFromDisplay("CA$99"), "CAD");
check("Australian dollar", extractCurrencyFromDisplay("A$99"), "AUD");
check("ISO prefix", extractCurrencyFromDisplay("GBP89.00"), "GBP");
check("ISO suffix", extractCurrencyFromDisplay("29.99 GBP"), "GBP");
check("ISO loose in a sentence", extractCurrencyFromDisplay("Price 4 000 UAH incl. VAT"), "UAH");
// No currency anywhere is an empty answer, not a default. This is the whole
// point of the change: a guess here is what priced a coat at $4,000.
check("no currency at all", extractCurrencyFromDisplay("Sale ends soon"), "");
check("bare number", extractCurrencyFromDisplay("4000"), "");

// ── 2. The conversion ────────────────────────────────────────────────────────

console.log("— rates and conversion —");

function freshFx() {
  delete require.cache[require.resolve(FX_PATH)];
  return require(FX_PATH);
}

let fetchCalls = 0;
function serveRates(rates) {
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      json: async () => ({
        result: "success",
        rates,
        time_last_update_utc: "Mon, 21 Sep 2026 00:00:01 +0000",
      }),
    };
  };
}

(async () => {
  // A live table.
  serveRates({ EUR: 0.85, GBP: 0.74, UAH: 41, PLN: 3.6, RUB: 80 });
  let fx = freshFx();

  const uah = await fx.toUsd(4000, "UAH");
  check("₴4,000 at 41/USD", uah && [uah.usd, uah.rate, uah.live], [97.56, 41, true]);
  check("rate day is kept", uah && uah.asOf, "2026-09-21");

  const gbp = await fx.toUsd(89, "GBP");
  check("£89 at 0.74/USD", gbp && gbp.usd, 120.27);

  const usd = await fx.toUsd(1290, "USD");
  check("dollars are left alone", usd && [usd.usd, usd.rate], [1290, 1]);

  // A currency the provider does not quote is not converted at all. Returning
  // null is what lets the importer keep the store's own number instead of
  // inventing a dollar figure.
  check("unquoted currency", await fx.toUsd(500, "XYZ"), null);
  check("no currency", await fx.toUsd(500, ""), null);

  // One table per hour, however many products the run imports.
  await fx.toUsd(10, "EUR");
  await fx.toUsd(20, "PLN");
  await fx.toUsd(30, "RUB");
  check("one fetch for the whole run", fetchCalls, 1);

  // A provider that is down must not stop an import: the fallback table is
  // used and flagged as such, so the admin's row can say "fallback rate".
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  fx = freshFx();
  const offline = await fx.toUsd(4100, "UAH");
  ok(
    "offline falls back and says so",
    offline && offline.live === false && offline.usd === 100,
    `got ${JSON.stringify(offline)}`,
  );

  // ── 3. Farfetch's shape: the gallery lives in the payload ───────────────────

  console.log("— the photos a single-page storefront hides in its payload —");

  const CDN = "https://cdn-images.farfetch-contents.com/28/53/00/33";
  const OTHER = "https://cdn-images.farfetch-contents.com/31/22/44/55";
  const pageUrl =
    "https://www.farfetch.com/shopping/women/wool-blend-bomber-jacket-item-28530033.aspx";

  /** The gallery, as the page's own data names it. */
  const galleryInPayload = [
    `${CDN}/28530033_54830862_1000.jpg`,
    `${CDN}/28530033_54830863_1000.jpg`,
    `${CDN}/28530033_54830864_1000.jpg`,
    `${CDN}/28530033_54830865_1000.jpg`,
    `${CDN}/28530033_54830866_1000.jpg`,
    `${CDN}/28530033_54830867_1000.jpg`,
  ];

  /** What a recommendations rail offers, on the same CDN. Must not be imported. */
  const otherProducts = [
    `${OTHER}/31224455_49999901_1000.jpg`,
    `${OTHER}/31224455_49999902_1000.jpg`,
  ];

  // The page AFTER the extension's strip: JSON-LD survives, scripts do not, and
  // the carousel has mounted exactly the slides it had rendered.
  const strippedHtml = `<html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Wool-blend bomber jacket",
      brand: { "@type": "Brand", name: "Acne Studios" },
      image: `${CDN}/28530033_54830861_1000.jpg`,
      offers: { "@type": "Offer", price: "1290", priceCurrency: "EUR" },
    })}</script>
    <meta property="og:image" content="${CDN}/28530033_54830861_1000.jpg" />
    </head><body>
    <div class="carousel">
      <img src="${CDN}/28530033_54830861_1000.jpg" alt="" />
      <img src="${CDN}/28530033_54830862_1000.jpg" alt="" />
    </div>
    <div class="recommendations"><img src="${OTHER}/31224455_49999901_1000.jpg" alt="" /></div>
    </body></html>`;

  // Before: markup alone. This is what the store was giving us — and what a
  // Shopify store would NOT lose, because there the gallery is in the markup.
  const before = normalizeExtract(extractProduct(strippedHtml, null, pageUrl), pageUrl, null);
  check("before: photos from the stripped page", before.images.length, 2);

  // After: the extension hands over what it read before stripping.
  const evidence = {
    images: [...galleryInPayload, ...otherProducts, "https://other-cdn.example/28530033_54830861_1000.jpg"],
    priceText: "€1,290",
  };
  const after = normalizeExtract(
    extractProduct(strippedHtml, null, pageUrl, evidence),
    pageUrl,
    null,
  );
  check("after: the whole gallery", after.images.length, 7);
  ok(
    "after: every payload photo is in",
    galleryInPayload.every((u) => after.images.includes(u)),
    `missing ${galleryInPayload.filter((u) => !after.images.includes(u)).join(", ")}`,
  );
  ok(
    "after: the recommendations rail stays out",
    !after.images.some((u) => u.includes("31224455")),
    `leaked ${after.images.filter((u) => u.includes("31224455")).join(", ")}`,
  );
  ok(
    "after: another CDN stays out",
    !after.images.some((u) => u.includes("other-cdn.example")),
  );
  check("after: the hero photo is unchanged", after.imageUrl, `${CDN}/28530033_54830861_1000.jpg`);
  check("after: the store's currency survives", [after.price, after.currency], [1290, "EUR"]);

  // A candidate list on its own is still filtered, with no markup to help.
  const harvested = harvestGalleryImages(
    "<html></html>",
    pageUrl,
    [`${CDN}/28530033_54830861_1000.jpg`],
    "Wool-blend bomber jacket",
    [...galleryInPayload, ...otherProducts],
  );
  check("candidates alone: only this product's", harvested.length, 6);

  // A payload that escapes every slash — how a doubly JSON-encoded script tag
  // spells an address — is mined by the server too, not only by the extension.
  const doublyEscaped =
    `<html><body><script type="application/json">` +
    `{"images":["https:\\/\\/cdn-images.farfetch-contents.com\\/28\\/53\\/00\\/33\\/28530033_54830868_1000.jpg"]}` +
    `</script></body></html>`;
  const fromPayload = harvestGalleryImages(
    doublyEscaped,
    pageUrl,
    [`${CDN}/28530033_54830861_1000.jpg`],
    "Wool-blend bomber jacket",
  );
  check("escaped slashes are unescaped and kept", fromPayload, [
    "https://cdn-images.farfetch-contents.com/28/53/00/33/28530033_54830868_1000.jpg",
  ]);

  // ── 4. A store that never states its currency in markup ────────────────────

  console.log("— the price the markup does not state —");

  const uahPage = `<html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Куртка бомбер",
      image: "https://shop.example.ua/img/bomber-1.jpg",
      offers: { "@type": "Offer", price: "4000" },
    })}</script>
    </head><body><span class="price">4 000 ₴</span></body></html>`;
  const uahUrl = "https://shop.example.ua/product/kurtka-bomber";

  const noHint = normalizeExtract(extractProduct(uahPage, null, uahUrl), uahUrl, null);
  check("without the rendered price: currency unknown", noHint.currency, "");
  ok(
    "without it: the product says so",
    noHint.issues.includes("currency not stated"),
    `issues: ${noHint.issues.join(", ")}`,
  );

  const withHint = normalizeExtract(
    extractProduct(uahPage, null, uahUrl, { priceText: "4 000 ₴" }),
    uahUrl,
    null,
  );
  check("with it: hryvnia", [withHint.price, withHint.currency], [4000, "UAH"]);
  ok("with it: no complaint", !withHint.issues.includes("currency not stated"));

  // And the conversion the importer will apply to it.
  serveRates({ UAH: 41 });
  fx = freshFx();
  const converted = await fx.toUsd(withHint.price, withHint.currency);
  check("₴4,000 lands as dollars", converted && converted.usd, 97.56);

  // A page with no price in its markup at all is rescued by the rendered text
  // rather than skipped.
  const noPriceMarkup = `<html><head>
    <meta property="og:title" content="Silk scarf" />
    <meta property="og:image" content="https://shop.example.pl/img/scarf.jpg" />
    </head><body><div class="product-price">1 299 zł</div></body></html>`;
  const rescued = normalizeExtract(
    extractProduct(noPriceMarkup, null, "https://shop.example.pl/p/silk-scarf", {
      priceText: "1 299 zł",
    }),
    "https://shop.example.pl/p/silk-scarf",
    null,
  );
  check("rescued price and currency", [rescued.price, rescued.currency], [1299, "PLN"]);

  // ── 5. How many photos a product keeps ─────────────────────────────────────

  console.log("— the cap —");

  check("shared cap", MAX_PRODUCT_IMAGES, 20);

  const many = Array.from({ length: 30 }, (_, i) => `${CDN}/28530033_5483${1000 + i}_1000.jpg`);
  const capped = normalizeExtract(
    { name: "Coat", price: "100", currency: "USD", images: many, sizes: [], strategies: [] },
    pageUrl,
    null,
  );
  check("thirty offered, twenty kept", capped.images.length, 20);

  // ── 6. The row, and a database that has not run migration 019 ──────────────

  console.log("— the row —");

  const row = productToDb({
    name: "Wool-blend bomber jacket",
    priceMin: 31.46,
    priceMax: 31.46,
    currency: "USD",
    sourcePrice: 1290,
    sourceCurrency: "UAH",
    fxRate: 41,
    fxDate: "2026-09-21",
  });
  check(
    "the store's own price is written beside ours",
    [row.price_min, row.currency, row.source_price, row.source_currency, row.fx_rate, row.fx_date],
    [31.46, "USD", 1290, "UAH", 41, "2026-09-21"],
  );

  const readBack = dbToProduct({
    id: "p1",
    name: "Wool-blend bomber jacket",
    brand: "Acne Studios",
    category: "outerwear",
    description: "",
    image_url: "",
    images: [],
    colors: [],
    color_images: null,
    sizes: [],
    material: "",
    retailers: [],
    price_min: 31.46,
    price_max: 31.46,
    currency: "USD",
    is_new: false,
    is_saved: false,
    style_keywords: [],
    created_at: new Date().toISOString(),
    source_price: 1290,
    source_currency: "UAH",
    fx_rate: 41,
    fx_date: "2026-09-21",
  });
  check(
    "and read back",
    [readBack.sourcePrice, readBack.sourceCurrency, readBack.fxRate, readBack.fxDate],
    [1290, "UAH", 41, "2026-09-21"],
  );

  // The four columns arrive with a migration, so a database that has not run it
  // must still take the product — the price is the point, the provenance is not.
  const attempts = [];
  const result = await writeRowDroppingUnknown(
    { name: "Coat", price_min: 31.46, source_price: 1290, source_currency: "UAH", fx_rate: 41, fx_date: "2026-09-21" },
    ["source_price", "source_currency", "fx_rate", "fx_date"],
    async (payload) => {
      attempts.push(Object.keys(payload));
      for (const column of ["source_price", "source_currency", "fx_rate", "fx_date"]) {
        if (column in payload) {
          return {
            data: null,
            error: {
              code: "PGRST204",
              message: `Could not find the '${column}' column of 'products' in the schema cache`,
            },
          };
        }
      }
      return { data: { id: "p1" }, error: null };
    },
  );
  ok(
    "a database without migration 019 still takes the product",
    result.error === null && result.data && result.data.id === "p1",
    JSON.stringify(result),
  );
  check("and names what it dropped", result.dropped.sort(), [
    "fx_date",
    "fx_rate",
    "source_currency",
    "source_price",
  ]);

  // ── Report ────────────────────────────────────────────────────────────────

  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
