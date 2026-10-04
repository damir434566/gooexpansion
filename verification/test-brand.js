/**
 * The brand a collected piece gets, and the Brands list it joins.
 *
 * Collected from GOAT, every piece came in as "Air Jordan". The extension read
 * the brand off the first brand-looking element on the page, which on GOAT is
 * the menu's first brand link; GOAT declares the brand nowhere else the parser
 * reads. And the importer, which checks a stated brand against the product's
 * name, kept any stated brand the catalogue already knew: after the first
 * piece, "Air Jordan" was known, and it held even over "New Balance 550" in a
 * name. Titles like "Dunk Low 'Panda'" name no brand at all.
 *
 * Runs the shipping modules: `decideBrand` and `brandFromModel`, the extractor
 * marking a brand that was only printed, and `importParsedProduct` adding a
 * new maker to the Brands list.
 */
const path = require("path");
const Module = require("module");

const COMPILED = path.join(__dirname, "compiled");
const FAKE = path.join(__dirname, "fake-supabase.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/supabase") return FAKE;
  if (request.startsWith("@/")) request = path.join(COMPILED, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

const db = require(FAKE);
const PARSER = path.join(COMPILED, "lib", "server", "parser");
const brandModule = require(path.join(PARSER, "brand-from-name.js"));
const { decideBrand } = brandModule;
// Absent before the model list existed, so the test reports rather than crashes there.
const brandFromModel = brandModule.brandFromModel ?? (() => "");
const { extractProduct } = require(path.join(PARSER, "extract.js"));
const { normalizeExtract } = require(path.join(PARSER, "normalize.js"));
const { importParsedProduct } = require(path.join(PARSER, "import-product.js"));

let pass = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else failures.push(`${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}

const KNOWN = ["Nike", "adidas", "New Balance", "Air Jordan", "Acne Studios", "Golden Goose", "Levi's", "Lemaire"];
const goat = (stated, name, weak = true) => decideBrand({ stated, name, host: "www.goat.com", known: KNOWN, weak }).brand;

(async () => {
  // ── GOAT: the menu's "Air Jordan", printed, against the name ───────────────
  check("GOAT: \"New Balance 550\" in the name beats the menu's Air Jordan", goat("Air Jordan", "New Balance 550 'White Green'"), "New Balance");
  check("GOAT: a Dunk is a Nike, not the menu's Air Jordan", goat("Air Jordan", "Dunk Low 'Panda'"), "Nike");
  check("GOAT: a Samba is an adidas", goat("Air Jordan", "Samba OG 'Cloud White Core Black'"), "adidas");
  check("GOAT: a 550 titled the way sneaker stores title it is a New Balance", goat("Air Jordan", "550 'White Green'"), "New Balance");
  check("GOAT: an Air Jordan stays one", goat("Air Jordan", "Air Jordan 4 Retro 'Bred Reimagined'"), "Air Jordan");
  check("GOAT: nothing printed, the model decides", goat("", "Gel-Kayano 14 'Cream Black'"), "ASICS");
  check("nothing printed and no model: no brand rather than a guess", goat("", "Wool Overcoat"), "");
  {
    const d = decideBrand({ stated: "Air Jordan", name: "Dunk Low 'Panda'", host: "www.goat.com", known: KNOWN, weak: true });
    check("and the decision says it came from the model in the name", { fromName: d.fromName, viaModel: d.viaModel }, { fromName: true, viaModel: true });
  }

  // ── What a page declares is still the store's word ─────────────────────────
  const declared = (stated, name, host = "shop.example") => decideBrand({ stated, name, host, known: KNOWN }).brand;
  check("declared Nike on a Jordan: one maker, the page's word", declared("Nike", "Air Jordan 1 Mid"), "Nike");
  check("declared Golden Goose on a Superstar: the page's word, not adidas", declared("Golden Goose", "Superstar Sneakers"), "Golden Goose");
  check("declared brand against a model's maker: the page's word", declared("Lemaire", "Samba OG collab"), "Lemaire");
  check("the store's own name as the brand: the name's brand", declared("Intertop", "Кросівки Nike Air Max 90", "intertop.ua"), "Nike");
  check("an unknown declared brand against a known one in the name: the name", declared("Oversized", "Acne Studios wool scarf"), "Acne Studios");
  check("a known declared brand the name does not repeat: kept", declared("Lemaire", "Twisted shirt"), "Lemaire");
  check("the catalogue's spelling of a model's maker", brandFromModel("Samba OG", ["Adidas"]), "Adidas");

  // ── The model list is sure of itself or silent ────────────────────────────
  for (const [name, want] of [
    ["Air Force 1 '07 'Triple White'", "Nike"],
    ["Air Max 90 'Infrared'", "Nike"],
    ["Blazer Mid '77 Vintage", "Nike"],
    ["Gazelle Indoor 'Bliss Pink'", "adidas"],
    ["Handball Spezial 'Navy'", "adidas"],
    ["2002R 'Protection Pack Rain Cloud'", "New Balance"],
    ["Chuck 70 Hi 'Black'", "Converse"],
    ["Old Skool 'Black White'", "Vans"],
    ["XT-6 'Black Phantom'", "Salomon"],
    ["Clifton 9 'Black White'", "HOKA"],
    ["Nuptse 1996 Retro Jacket", "The North Face"],
    // A word that is also a model, without what makes it the shoe:
    ["Wool Blazer", ""],
    ["Superstar Sneakers", ""],
    ["550 Relaxed Fit Jeans", ""],
    ["Levi's 550 '92 Relaxed Taper", "New Balance"],
    ["Boston Bag", ""],
    ["Slip-On Loafers", ""],
    ["Club Collar Shirt", ""],
  ]) {
    if (name === "Levi's 550 '92 Relaxed Taper") {
      // The one shape the 550 rule cannot tell apart; the name's own brand
      // comes first and settles it.
      check("Levi's 550 '92: the brand in the name wins over the model", goat("", name), "Levi's");
      continue;
    }
    check(`model of "${name}"`, brandFromModel(name), want);
  }

  // ── The extractor marks a brand that was only printed ─────────────────────
  {
    const bare = "<html><head><title>Dunk Low 'Panda' | GOAT</title></head><body><h1>Dunk Low 'Panda'</h1></body></html>";
    const raw = extractProduct(bare, null, "https://www.goat.com/sneakers/dunk-low-panda", { brandText: "Air Jordan" });
    check("printed only: the brand is marked as printed", { brand: raw.brand, brandFromText: raw.brandFromText }, { brand: "Air Jordan", brandFromText: true });
    const parsed = normalizeExtract(raw, "https://www.goat.com/sneakers/dunk-low-panda");
    check("and the mark reaches the importer", parsed.brandFromText, true);

    const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Dunk Low 'Panda'", brand: { "@type": "Brand", name: "Nike" }, offers: { "@type": "Offer", price: "110", priceCurrency: "USD" } });
    const declaredPage = `<html><head><script type="application/ld+json">${ld}</script></head><body><h1>Dunk Low 'Panda'</h1></body></html>`;
    const raw2 = extractProduct(declaredPage, null, "https://www.goat.com/sneakers/dunk-low-panda", { brandText: "Air Jordan" });
    check("declared in structured data: the page's brand, not marked", { brand: raw2.brand, brandFromText: raw2.brandFromText }, { brand: "Nike", brandFromText: undefined });
  }

  // ── Through the importer: the brand, and the Brands list ──────────────────
  const piece = (name, brand, extra = {}) => ({
    name,
    brand,
    brandFromText: true,
    category: "footwear",
    colors: ["White"],
    price: 110,
    currency: "USD",
    images: ["https://image.goat.com/1.jpg"],
    imageUrl: "https://image.goat.com/1.jpg",
    ...extra,
  });
  db.reset([], { brands: ["Nike", "adidas", "Air Jordan"] });
  {
    const r = await importParsedProduct(piece("Dunk Low 'Panda'", "Air Jordan"), "https://www.goat.com/sneakers/dunk-low-panda", {});
    const row = db.inserts()[0]?.row ?? {};
    check("imported from GOAT: the Dunk is filed under Nike", row.brand, "Nike");
    check("the row says why", /brand Nike from the model in the name \(page said Air Jordan\)/.test(r.brandNote || ""), true);
    check("Nike is on the list already: nothing added", db.brandsAdded(), []);
  }
  {
    db.reset([]);
    const r = await importParsedProduct(piece("Gel-Kayano 14 'Cream Black'", ""), "https://www.goat.com/sneakers/gel-kayano-14", {});
    check("a maker the Brands list lacks is added to it", db.brandsAdded(), ["ASICS"]);
    check("and the row says so", /ASICS added to the Brands list/.test(r.brandNote || ""), true);
  }
  {
    db.reset([]);
    await importParsedProduct(piece("Gel-NYC 'Graphite Grey'", ""), "https://www.goat.com/sneakers/gel-nyc", {});
    check("added once: the next ASICS finds it there", db.brandsAdded(), []);
  }
  {
    db.reset([]);
    await importParsedProduct(piece("Wool Overcoat", "GOAT", { brandFromText: false }), "https://www.goat.com/apparel/wool-overcoat", {});
    check("the store's own name is never added as a brand", db.brandsAdded(), []);
  }
  {
    db.reset([]);
    await importParsedProduct(piece("Clifton 9 'Black White'", ""), "https://www.goat.com/sneakers/clifton-9", { linksOnly: true });
    check("a links-only run adds nothing to the list", db.brandsAdded(), []);
  }

  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
