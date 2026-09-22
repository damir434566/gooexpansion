/**
 * The fields a product used to arrive without.
 *
 * Ten of them were reported missing: brand, category, subcategory, sizes,
 * description, material, colour name, colour filter, style, variant grouping
 * and the same piece on another site. Each is a part of its own, and each part
 * adds its section here, against the real modules out of `verification/compiled`.
 *
 *   Part 1 — sizes
 *   Part 2 — colour, the colour filter, and grouping colourways
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
const { looksLikeSize, pickSizes, colorGroupNamesFor } = require(
  path.join(COMPILED, "lib", "server", "product-fields.js"),
);
const { isColorSiblingByName, chooseGroup, variantBaseName } = require(
  path.join(PARSER, "variant-group.js"),
);

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
}

function ok(name, condition, detail = "") {
  if (condition) pass++;
  else failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
}

const PAGE = "https://shop.example.com/product/wool-coat";

/** A product page with the fields under test and nothing else. */
function page(ld, body = "") {
  return `<html><head><script type="application/ld+json">${JSON.stringify(
    ld,
  )}</script></head><body>${body}</body></html>`;
}

const BASE = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Wool Coat",
  image: "https://shop.example.com/img/coat-1.jpg",
  offers: { "@type": "Offer", price: "249", priceCurrency: "EUR" },
};

// ── Part 1: sizes ────────────────────────────────────────────────────────────

console.log("— what reads as a size —");

for (const label of ["XS", "s", "M", "XXL", "3XL", "M/L", "XS-S"]) {
  ok(`letter size ${label}`, looksLikeSize(label));
}
for (const label of ["38", "40,5", "9.5", "EU 38", "38 EU", "UK10", "IT 42"]) {
  ok(`number size ${label}`, looksLikeSize(label));
}
for (const label of ["32x34", "32/34", "W32 L34"]) {
  ok(`waist and length ${label}`, looksLikeSize(label));
}
for (const label of ["One size", "one-size", "OS", "Единый размер", "Taille unique"]) {
  ok(`the size that is not one: ${label}`, looksLikeSize(label));
}
// The junk that shares a page corner with the sizes.
for (const label of [
  "Select size",
  "Size guide",
  "Розмірна сітка",
  "Add to bag",
  "Sold out",
  "Charcoal",
  "249 EUR",
  "1290",
  "",
  "Fits true to size, we recommend taking your usual",
]) {
  ok(`not a size: ${label || "(empty)"}`, !looksLikeSize(label));
}

console.log("— the list off the page —");

check(
  "junk filtered, page order kept, duplicates dropped",
  pickSizes(["Select size", "XS", "S", "M", " M ", "Size guide", "XL", "Sold out"]),
  ["XS", "S", "M", "XL"],
);
check("a list with nothing in it", pickSizes(["Select size", "Add to bag"]), []);
check("not a list at all", pickSizes(undefined), []);
check("the cap is honoured", pickSizes(["36", "37", "38", "39", "40"], 3), ["36", "37", "38"]);

console.log("— sizes out of structured data —");

check(
  "size on the product, as a string",
  normalizeExtract(extractProduct(page({ ...BASE, size: "M" }), null, PAGE), PAGE, null).sizes,
  ["M"],
);
check(
  "size on the product, as a list",
  normalizeExtract(extractProduct(page({ ...BASE, size: ["S", "M", "L"] }), null, PAGE), PAGE, null)
    .sizes,
  ["S", "M", "L"],
);
check(
  "hasVariant, the schema.org way",
  normalizeExtract(
    extractProduct(
      page({
        ...BASE,
        hasVariant: [
          { "@type": "Product", size: "36" },
          { "@type": "Product", size: "38" },
          { "@type": "Product", size: { "@type": "SizeSpecification", name: "40" } },
        ],
      }),
      null,
      PAGE,
    ),
    PAGE,
    null,
  ).sizes,
  ["36", "38", "40"],
);
check(
  "offers, the older way, with the size on what is offered",
  normalizeExtract(
    extractProduct(
      page({
        ...BASE,
        offers: [
          { "@type": "Offer", price: "249", priceCurrency: "EUR", size: "S" },
          { "@type": "Offer", price: "249", priceCurrency: "EUR", itemOffered: { size: "M" } },
        ],
      }),
      null,
      PAGE,
    ),
    PAGE,
    null,
  ).sizes,
  ["S", "M"],
);
check(
  "additionalProperty named size, in another language",
  normalizeExtract(
    extractProduct(
      page({ ...BASE, additionalProperty: [{ name: "Размер", value: ["44", "46"] }] }),
      null,
      PAGE,
    ),
    PAGE,
    null,
  ).sizes,
  ["44", "46"],
);
// This is the regression that matters: it used to be hard-coded empty.
check(
  "a page with no sizes anywhere still has none",
  normalizeExtract(extractProduct(page(BASE), null, PAGE), PAGE, null).sizes,
  [],
);

console.log("— sizes off the rendered control —");

const withEvidence = normalizeExtract(
  extractProduct(page(BASE), null, PAGE, {
    sizes: ["Select size", "XS", "S", "M", "L", "XL", "Size guide"],
  }),
  PAGE,
  null,
);
check("what the extension saw, filtered", withEvidence.sizes, ["XS", "S", "M", "L", "XL"]);

// Structured data wins: the two vocabularies must not be merged, or "40",
// "EU 40" and "IT 40" become three sizes of a coat that has one.
const both = normalizeExtract(
  extractProduct(page({ ...BASE, size: ["40", "42"] }), null, PAGE, {
    sizes: ["EU 40", "EU 42", "EU 44"],
  }),
  PAGE,
  null,
);
check("the store's own data beats the control", both.sizes, ["40", "42"]);

// A recipe rule an admin wrote beats both.
const ruled = normalizeExtract(
  extractProduct(
    page({ ...BASE, size: ["40"] }, "<div>sizes:S|M|L</div>"),
    { id: "r", name: "recipe", domain: "shop.example.com", enabled: true, rules: { sizes: { regex: "sizes:([^<]+)" } } },
    PAGE,
    { sizes: ["EU 40"] },
  ),
  PAGE,
  null,
);
check("and a recipe rule beats the data", ruled.sizes, ["S", "M", "L"]);

// ── Part 2: colour, the filter, and colourway grouping ───────────────────────

console.log("— the colour the page is showing —");

// A store that states its colour as data is believed first.
check(
  "structured data wins",
  normalizeExtract(
    extractProduct(page({ ...BASE, color: "Charcoal" }), null, PAGE, { colorText: "Sand" }),
    PAGE,
    null,
  ).colors,
  ["Charcoal"],
);
// Most do not, and then the selected swatch is the only statement there is.
check(
  "the swatch the shopper selected",
  normalizeExtract(extractProduct(page(BASE), null, PAGE, { colorText: "Charcoal" }), PAGE, null)
    .colors,
  ["Charcoal"],
);
// And it beats the markup scan, which on a page with six colourways can name
// any of them.
check(
  "the swatch beats a scan of the markup",
  normalizeExtract(
    extractProduct(page(BASE, '<div data-color="Sand"></div>'), null, PAGE, {
      colorText: "Charcoal",
    }),
    PAGE,
    null,
  ).colors,
  ["Charcoal"],
);
check(
  "a page that says nothing about colour",
  normalizeExtract(extractProduct(page(BASE), null, PAGE), PAGE, null).colors,
  [],
);

console.log("— the colour filter —");

// The filter is built from the colour name, which is why the name mattered.
check("a store's shade word files under a filter group", colorGroupNamesFor("Charcoal"), ["Grey"]);
check("two colours file under both, and multicolour", colorGroupNamesFor("Black/White"), [
  "Black",
  "White",
  "Multicolor",
]);
check("a two-word colourway is one colour", colorGroupNamesFor("Natural Black"), ["Black"]);
check("a word that names no colour files nowhere", colorGroupNamesFor("Limited Edition"), []);

console.log("— the addresses of the other colourways —");

const linked = normalizeExtract(
  extractProduct(page(BASE), null, PAGE, {
    variantUrls: [
      "/product/wool-coat-sand",
      "https://shop.example.com/product/wool-coat-navy",
      "/product/wool-coat-sand",
      PAGE,
      // What else lives in a colour row.
      "/care",
      "/size-guide",
      "/cart",
      "https://other-shop.example/product/wool-coat-sand",
    ],
  }),
  PAGE,
  null,
);
check("resolved, de-duplicated, and this page is not its own variant", linked.variantUrls, [
  "https://shop.example.com/product/wool-coat-sand",
  "https://shop.example.com/product/wool-coat-navy",
]);

console.log("— deciding that two rows are one piece in two colours —");

const ours = { brand: "Fixture Atelier", name: "Wool Blend Coat - Charcoal", colors: ["Charcoal"] };
const row = (id, name, colors, extra = {}) => ({ id, name, colors, ...extra });

check("base name drops the colour suffix", variantBaseName("Wool Blend Coat - Charcoal"), "wool blend coat");
ok(
  "same base name, different colour → variants",
  isColorSiblingByName(ours, row("b", "Wool Blend Coat - Sand", ["Sand"])),
);
ok(
  "a longer name that merely starts the same → NOT variants",
  !isColorSiblingByName(ours, row("b", "Wool Blend Coat Long - Sand", ["Sand"])),
  "this is what a prefix query over-fetches, and why the exact test exists",
);
ok(
  "same colour → not a colourway of itself",
  !isColorSiblingByName(ours, row("b", "Wool Blend Coat - Charcoal", ["Charcoal"])),
);
ok(
  "no brand → no grouping by name at all",
  !isColorSiblingByName({ ...ours, brand: "" }, row("b", "Wool Blend Coat - Sand", ["Sand"])),
);
ok(
  "a name too short to identify anything",
  !isColorSiblingByName(
    { brand: "Fixture Atelier", name: "Tee - Black", colors: ["Black"] },
    row("b", "Tee - White", ["White"]),
  ),
);
ok(
  "an unknown colour on one side still groups",
  isColorSiblingByName(ours, row("b", "Wool Blend Coat", [])),
);

check(
  "an existing group is joined rather than replaced",
  chooseGroup([
    row("b", "Wool Blend Coat - Sand", ["Sand"], { variantGroupId: "g1", isGroupPrimary: true }),
    row("c", "Wool Blend Coat - Navy", ["Navy"], { variantGroupId: "g1" }),
  ]),
  { groupId: "g1", hasPrimary: true },
);
check(
  "siblings with no group yet: a new one, and this row may lead it",
  chooseGroup([row("b", "Wool Blend Coat - Sand", ["Sand"])]),
  { groupId: undefined, hasPrimary: false },
);
check(
  "a group whose primary is missing is led by whoever arrives",
  chooseGroup([row("b", "Wool Blend Coat - Sand", ["Sand"], { variantGroupId: "g2" })]),
  { groupId: "g2", hasPrimary: false },
);

console.log("");
for (const f of failures) console.log(`  ✗ ${f}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
