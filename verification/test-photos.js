/**
 * Photos: one of each, and only this product's.
 *
 * Two complaints from real runs: the same photo stored several times, and
 * photos of other products in the gallery. Each case below is a shape that
 * produced one or the other.
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
const { imageKey, harvestGalleryImages } = require(path.join(PARSER, "gallery.js"));
const { normalizeExtract } = require(path.join(PARSER, "normalize.js"));
const { mergeShopifyIntoRaw } = require(path.join(PARSER, "shopify.js"));

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
};

/** How many distinct photos a list holds, after the product's own dedupe. */
function photosAfterNormalize(images, sourceUrl) {
  return normalizeExtract({ name: "Piece", images, strategies: [] }, sourceUrl, null).images;
}

console.log("— one photo, many addresses —");
{
  const store = "https://mowalola.com/products/jordan-leather-jkt";
  const same = [
    "https://cdn.shopify.com/s/files/1/0123/4567/8901/files/JORDAN-JKT-FRONT.jpg?v=1700000000",
    "https://mowalola.com/cdn/shop/files/JORDAN-JKT-FRONT.jpg?v=1700000000&width=1100",
    "//mowalola.com/cdn/shop/files/JORDAN-JKT-FRONT_600x.jpg?v=1700000000",
  ];
  check("Shopify CDN and the store's /cdn/shop/ are one file", photosAfterNormalize(same, store).length, 1);

  const wp = "https://shop.example.com/product/wool-coat/";
  const wpSame = [
    "https://shop.example.com/wp-content/uploads/2026/09/wool-coat-front.jpg",
    "https://shop.example.com/wp-content/uploads/2026/09/wool-coat-front-300x300.jpg",
    "https://shop.example.com/wp-content/uploads/2026/09/wool-coat-front-768x1024.jpg",
    "https://shop.example.com/wp-content/uploads/2026/09/wool-coat-front-scaled.jpg",
  ];
  check("WordPress thumbnails are the one photo", photosAfterNormalize(wpSame, wp).length, 1);

  const formats = [
    "https://img.example.com/p/wool-coat-front.jpg",
    "https://img.example.com/p/wool-coat-front.jpg.webp",
    "https://img.example.com/p/wool-coat-front@2x.jpg",
    "https://img.example.com/p/wool-coat-front.webp",
  ];
  check("formats and retina renditions are the one photo", photosAfterNormalize(formats, wp).length, 1);

  const ff = [
    "https://cdn-images.farfetch-contents.com/28/53/00/33/28530033_54830861_1000.jpg",
    "https://cdn-images.farfetch-contents.com/28/53/00/33/28530033_54830861_480.jpg",
    "https://cdn-images.farfetch-contents.com/28/53/00/33/28530033_54830868_1000.jpg",
  ];
  check("Farfetch sizes are one photo, frames stay two", photosAfterNormalize(ff, "https://www.farfetch.com/shopping/x-item-28530033.aspx").length, 2);

  check(
    "distinct frames are not merged",
    photosAfterNormalize(
      ["https://img.example.com/p/All-birds_0010.jpg", "https://img.example.com/p/All-birds_0017.jpg"],
      wp,
    ).length,
    2,
  );
  check(
    "a WordPress-looking size outside wp-content is left alone",
    imageKey("https://img.example.com/p/poster-1x1.jpg") === imageKey("https://img.example.com/p/poster.jpg"),
    false,
  );
}

console.log("— only this product's photos —");
{
  const page = "https://shop.example.com/products/black-leather-jacket";
  const trusted = ["https://cdn.example.com/files/black-leather-jacket-front.jpg"];
  const html = `<main>
    <img src="https://cdn.example.com/files/black-leather-jacket-back.jpg">
    <img src="https://cdn.example.com/files/brown-leather-jacket-1.jpg">
    <img src="https://cdn.example.com/files/suede-leather-jacket-tan.jpg">
  </main>`;
  const got = harvestGalleryImages(html, page, trusted, "Black Leather Jacket");
  check("its own back view is kept", got.includes("https://cdn.example.com/files/black-leather-jacket-back.jpg"), true);
  check("a brown leather jacket is not this one", got.some((u) => /brown/.test(u)), false);
  check("nor a suede one", got.some((u) => /suede/.test(u)), false);

  const shoot = harvestGalleryImages(
    '<img src="https://cdn.example.com/files/DSC01240.jpg"><img src="https://cdn.example.com/files/IMG_4410.jpg">',
    "https://shop.example.com/products/wool-coat",
    ["https://cdn.example.com/files/DSC01234.jpg", "https://cdn.example.com/files/IMG_4417.jpg"],
    "Wool Coat",
  );
  check("camera numbers from one shoot are not frames of one product", shoot, []);

  const named = harvestGalleryImages(
    '<img src="https://cdn.example.com/files/nebula-aurelio-jacket-2.jpg">',
    "https://shop.example.com/products/nebula-aurelio-jacket",
    ["https://cdn.example.com/files/hero.jpg"],
    "Nebula Aurelio Jacket",
  );
  check("a file named for the product itself is still found", named.length, 1);
}

console.log("— Shopify's own record is the gallery —");
{
  const page = "https://mowalola.com/products/jordan-leather-jkt";
  const raw = {
    name: "MOWALOLA",
    images: [
      "https://mowalola.com/cdn/shop/files/JORDAN-JKT-FRONT.jpg?v=1",
      "https://mowalola.com/cdn/shop/files/LEATHER-JKT-BROWN-1.jpg?v=1",
      "https://mowalola.com/cdn/shop/files/BUMSTER-LEATHER-JKT.jpg?v=1",
    ],
    strategies: ["json-ld", "gallery"],
  };
  const product = {
    title: "JORDAN LEATHER JACKET",
    handle: "jordan-leather-jkt",
    vendor: "Mowalola",
    options: [],
    variants: [{ price: "1200.00", option1: "S" }],
    images: [
      { src: "https://cdn.shopify.com/s/files/1/0123/4567/files/JORDAN-JKT-FRONT.jpg?v=1", position: 1 },
      { src: "https://cdn.shopify.com/s/files/1/0123/4567/files/JORDAN-JKT-BACK.jpg?v=1", position: 2 },
    ],
  };
  const merged = mergeShopifyIntoRaw(raw, product, page, "GBP");
  const final = normalizeExtract(merged, page, null).images;
  check("two photos: the store's own list, once each", final.length, 2);
  check("no other jacket from the page", final.some((u) => /BROWN|BUMSTER/i.test(u)), false);
}

console.log("");
for (const f of failures) console.log(`  ✗ ${f}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
