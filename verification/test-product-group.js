/**
 * A product page that states its piece as a `ProductGroup`, or states it twice.
 *
 * Before this, both were read as listings: every variant under `hasVariant` was
 * counted as a product of its own, a page with two or more is a "listing", and
 * the listing path takes the first JSON-LD card for the product and drops
 * everything the extension read off the rendered page. That is one bug behind
 * most of the "not always" in the report — photos, sizes, colour, description,
 * material, brand and the currency next to the price all went missing together.
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
const { extractProduct, partitionProducts } = require(path.join(PARSER, "extract.js"));
const { normalizeExtract } = require(path.join(PARSER, "normalize.js"));
const { parsePage } = require(path.join(PARSER, "parse-page.js"));

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

const PAGE = "https://shop.example.com/products/wool-coat";

function page(blocks, body = "") {
  const scripts = blocks
    .map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`)
    .join("");
  return `<html><head>${scripts}</head><body>${body}</body></html>`;
}

function variant(color, size, gtin, extra = {}) {
  return {
    "@type": "Product",
    name: `Wool Coat - ${color} / ${size}`,
    color,
    size,
    gtin13: gtin,
    image: `https://cdn.shop.example.com/files/wool-coat-${color.toLowerCase()}-1.jpg`,
    url: `${PAGE}?variant=${color}-${size}`,
    offers: { "@type": "Offer", price: "200.00", priceCurrency: "EUR", availability: "InStock" },
    ...extra,
  };
}

// Valid EAN-13s (check digits verified).
const GROUP = {
  "@context": "https://schema.org",
  "@type": "ProductGroup",
  name: "Wool Coat",
  description: "<p>Double-faced wool coat with a notched lapel. 80% wool, 20% polyamide.</p>",
  brand: { "@type": "Brand", name: "Nordwind" },
  productGroupID: "NW-1042",
  variesBy: ["https://schema.org/color", "https://schema.org/size"],
  hasVariant: [
    variant("Black", "S", "4006381333931"),
    variant("Black", "M", "4006381333924"),
    variant("Black", "L", "4006381333917"),
    variant("Camel", "S", "5901234123457"),
    variant("Camel", "M", "4012345000009"),
  ],
};

const EVIDENCE = {
  images: [
    "https://cdn.shop.example.com/files/wool-coat-black-1.jpg",
    "https://cdn.shop.example.com/files/wool-coat-black-2.jpg",
    "https://cdn.shop.example.com/files/wool-coat-black-3.jpg",
  ],
  priceText: "200,00 €",
  sizes: ["S", "M", "L"],
  colorText: "Black",
  variantUrls: [],
  descriptionText: "",
  specs: [{ key: "Material", value: "80% wool, 20% polyamide" }],
  breadcrumbs: ["Home", "Women", "Coats"],
  brandText: "",
};

const OPTS = {
  fetchSettings: { provider: "direct" },
  fetchApiKey: "",
  siteConfigs: [],
  aiSettings: { enabled: false, mode: "fallback" },
  useAi: false,
};

(async () => {
  console.log("— a ProductGroup is one piece, not a listing —");
  {
    const html = page([GROUP]);
    const parts = partitionProducts(html);
    check("group counted once", parts.standaloneCount, 1);

    const result = await parsePage(PAGE, { ...OPTS, html });
    check("not a listing", result.isListing, false);
    check("one product", result.products.length, 1);
    const p = result.products[0];
    check("name from the group, not a variant", p.name, "Wool Coat");
    check("brand from the group", p.brand, "Nordwind");
    check("price", p.price, 200);
    check("currency", p.currency, "EUR");
    check("colour of the shown variant", p.colors, ["Black"]);
    check("sizes of the shown colour only", p.sizes, ["S", "M", "L"]);
    ok("description from the group", /notched lapel/.test(p.description ?? ""), p.description);
    ok("no camel photo in the black coat", !(p.images ?? []).some((u) => /camel/.test(u)), JSON.stringify(p.images));
    check("gtin of the shown variant", p.gtin, "4006381333931");
    ok(
      "the camel colourway offered for grouping",
      (p.variantUrls ?? []).some((u) => /variant=Camel/.test(u)),
      JSON.stringify(p.variantUrls),
    );
  }

  console.log("— the page's own variant is the one it shows —");
  {
    const url = `${PAGE}?variant=Camel-M`;
    const raw = extractProduct(page([GROUP]), null, url);
    check("camel page reads camel", raw.color, "Camel");
    check("camel sizes", raw.sizes, ["S", "M"]);
    check("camel gtin", raw.gtin, "4012345000009");
  }

  console.log("— the extension's evidence survives a group page —");
  {
    const html = page([GROUP]);
    const result = await parsePage(PAGE, { ...OPTS, html, evidence: EVIDENCE });
    const p = result.products[0];
    check("three photos", (p.images ?? []).length, 3);
    check("material from the spec row", p.material, "80% wool, 20% polyamide");
  }

  console.log("— the same piece stated twice (theme + reviews app) —");
  {
    const theme = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Wool Coat",
      image: ["https://cdn.shop.example.com/files/wool-coat-black-1.jpg"],
      brand: "Nordwind",
      offers: { "@type": "Offer", price: "200", priceCurrency: "EUR" },
    };
    const reviews = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Wool Coat",
      aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8", reviewCount: "31" },
    };
    const html = page([reviews, theme]);
    const result = await parsePage(PAGE, { ...OPTS, html });
    check("not a listing", result.isListing, false);
    const p = result.products[0];
    check("price from the fuller statement", p.price, 200);
    check("currency from the fuller statement", p.currency, "EUR");
    check("brand", p.brand, "Nordwind");
  }

  console.log("— a variant page that names its group —");
  {
    const html = page([
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Wool Coat Black",
        color: "Black",
        offers: { "@type": "Offer", price: "200", priceCurrency: "EUR" },
        isVariantOf: {
          "@type": "ProductGroup",
          name: "Wool Coat",
          brand: { "@type": "Brand", name: "Nordwind" },
          description: "Double-faced wool coat.",
          hasVariant: [{ "@type": "Product", name: "Wool Coat Camel", color: "Camel" }],
        },
      },
    ]);
    const parts = partitionProducts(html);
    check("one piece", parts.standaloneCount, 1);
    const raw = extractProduct(html, null, PAGE);
    check("own name", raw.name, "Wool Coat Black");
    check("brand from the group", raw.brand, "Nordwind");
    check("description from the group", raw.description, "Double-faced wool coat.");
  }

  console.log("— the extension's page never borrows a related product —");
  {
    const html = page([
      {
        "@context": "https://schema.org",
        "@type": "ItemList",
        itemListElement: [
          { "@type": "ListItem", position: 1, item: { "@type": "Product", name: "Silk Scarf", offers: { price: "40", priceCurrency: "EUR" } } },
          { "@type": "ListItem", position: 2, item: { "@type": "Product", name: "Leather Belt", offers: { price: "60", priceCurrency: "EUR" } } },
        ],
      },
    ], '<h1>Wool Coat</h1><meta property="og:title" content="Wool Coat">');
    const result = await parsePage(PAGE, { ...OPTS, html, evidence: EVIDENCE });
    check("read as the page's product", result.isListing, false);
    const p = result.products[0];
    ok("not the scarf", p && p.name !== "Silk Scarf", p && p.name);
    check("currency from the printed price", p && p.currency, "EUR");
    check("price from the printed price", p && p.price, 200);
  }

  console.log("— related items named in the product itself —");
  {
    const html = page([
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Wool Coat",
        offers: { price: "200", priceCurrency: "EUR" },
        isSimilarTo: [
          { "@type": "Product", name: "Cashmere Coat" },
          { "@type": "Product", name: "Trench Coat" },
        ],
      },
    ]);
    check("similar items are not the page's own", partitionProducts(html).standaloneCount, 1);
  }

  console.log("— a real listing is still a listing —");
  {
    const html = page([
      { "@context": "https://schema.org", "@type": "Product", name: "Wool Coat", url: `${PAGE}`, offers: { price: "200", priceCurrency: "EUR" } },
      { "@context": "https://schema.org", "@type": "Product", name: "Trench Coat", url: "https://shop.example.com/products/trench", offers: { price: "180", priceCurrency: "EUR" } },
    ]);
    const result = await parsePage("https://shop.example.com/collections/coats", { ...OPTS, html });
    check("listing without evidence", result.isListing, true);
    check("two cards", result.products.length, 2);
  }

  console.log("");
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
