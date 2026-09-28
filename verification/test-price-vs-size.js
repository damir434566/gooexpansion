/**
 * A size is not a price.
 *
 * On a store whose size picker prices every size (GOAT and the like), the
 * extension read a tile's text — "18" with "$215" under it — as "18\n$", and
 * the server stored the product at $18. The page stated no price in its markup,
 * so that rendered text was the only price there was.
 *
 * Runs the real extractor and normaliser on such a page with what each
 * extension version sends, and the server's own reading of a rendered price
 * (`priceInDisplay`) on the shapes real stores print.
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
const { priceInDisplay } = require(path.join(COMPILED, "lib", "server", "product-fields.js"));

let pass = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else failures.push(`${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}

const URL_ = "https://www.goat.example/sneakers/air-jordan-4-retro-bred-reimagined-fv5029-006";
// The page as the extension sends it: markup with no price anywhere in it.
const HTML = `<html lang="en"><head><title>Air Jordan 4 Retro 'Bred Reimagined' | GOAT</title></head>
<body><main><h1>Air Jordan 4 Retro 'Bred Reimagined'</h1></main></body></html>`;

function read(priceText, sizes = ["4", "10.5", "18"]) {
  const raw = extractProduct(HTML, null, URL_, { priceText, sizes, images: [] });
  const p = normalizeExtract(raw, URL_, null);
  return { price: p.price, currency: p.currency };
}

console.log("— what the extension sent from a size picker —");
check("1.0.10 and before, the tile on two lines: not $18", read("18\n$").price === 18, false);
check("  …and no price is made up instead", read("18\n$").price, 0);
check("1.0.10 and before, the tile on one line: not $18", read("18 $").price === 18, false);
check("  …told by the page's sizes, the size spelled \"US 18\" too", read("18 $", ["US 17", "US 18"]).price === 18, false);
check("a dollar price that is no size stands", read("25 $", ["4", "18"]), { price: 25, currency: "USD" });
check("18 euro beside a size 18 stays 18 euro", read("18 €", ["16", "18"]), { price: 18, currency: "EUR" });
check("1.0.11, the tile's own price", read("$215"), { price: 215, currency: "USD" });
check("a whole tile's text, if a store's markup hands it over", read("18\n$215"), { price: 215, currency: "USD" });
check("size and price on one line", read("18 $120"), { price: 120, currency: "USD" });

console.log("— real prices still read as they did —");
const cases = [
  ["$215", "$215"],
  ["18,00 €", "18,00 €"],
  ["from 18 €", "18 €"],
  ["4 000 ₴", "4 000 ₴"],
  ["4 000 грн", "4 000 грн"],
  ["1.299,00 €", "1.299,00 €"],
  ["$1,299.00", "$1,299.00"],
  ["£89", "£89"],
  ["CA$ 215", "CA$ 215"],
  ["US$215", "US$215"],
  ["12 990 руб", "12 990 руб"],
  ["UAH 4000", "UAH 4000"],
  ["Size 18 — €215", "€215"],
  ["18 € 215", "€ 215"],
  ["Sale ends soon", ""],
  ["4000", ""],
  ["18\n$", ""],
];
for (const [text, want] of cases) check(`priceInDisplay(${JSON.stringify(text)})`, priceInDisplay(text), want);
check("18 euro is 18 euro", read("18,00 €"), { price: 18, currency: "EUR" });
check("hryvnia with no-break spaces", read("4 000 ₴"), { price: 4000, currency: "UAH" });
check("a Canadian dollar stays Canadian", read("CA$ 215"), { price: 215, currency: "CAD" });

console.log("— the markup's own price still comes first —");
{
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Air Jordan 4 Retro",
    offers: { "@type": "Offer", price: "230", priceCurrency: "USD" },
  })}</script></head><body><h1>Air Jordan 4 Retro</h1></body></html>`;
  const p = normalizeExtract(extractProduct(html, null, URL_, { priceText: "18\n$215", sizes: ["18"], images: [] }), URL_, null);
  check("structured data over the rendered text", { price: p.price, currency: p.currency }, { price: 230, currency: "USD" });
}

console.log("");
for (const f of failures) console.log(`  ✗ ${f}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
