/**
 * Timberland: the store's sales line came in as the brand, and a card carrying
 * it was never grouped with its own colourways.
 *
 * Timberland prints a line under each product's title — "Excluded from all
 * promotional discounts and offers", "Wides Available", "More Info About Extra
 * 30% Off In Cart!" — and the extension, which reads the brand-looking element
 * nearest the title, sent it as the brand. The site saved it, put it on the
 * Brands list, and from then on knew it as a brand: it even beat the
 * "Timberland®" in a product's own name. A card saved under it was another
 * maker's piece to the colour grouping, so "Men's Euro Hiker" in brown stood
 * apart from the black and the wheat ones beside it.
 *
 * Runs the shipping modules: `isSalesCopy` and `decideBrand`, the extractor,
 * the colour-group and same-item tests, and `importParsedProduct` over a
 * `live` fake database, so each import sees what the last one saved.
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
// No photo is fetched: the importer's colour and backdrop readings get nothing.
global.fetch = async () => new Response("no", { status: 404 });

const PARSER = path.join(COMPILED, "lib", "server", "parser");
const brandModule = require(path.join(PARSER, "brand-from-name.js"));
const { decideBrand } = brandModule;
// Absent before this change, so the test reports rather than crashes there.
const isSalesCopy = brandModule.isSalesCopy ?? (() => false);
const { extractProduct } = require(path.join(PARSER, "extract.js"));
const { normalizeExtract } = require(path.join(PARSER, "normalize.js"));
const { isSamePieceByName } = require(path.join(PARSER, "variant-group.js"));
const { importParsedProduct } = require(path.join(PARSER, "import-product.js"));

let pass = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else failures.push(`${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}

const EXCLUDED = "Excluded from all promotional discounts and offers";
const WIDES = "Wides Available";
const CART = "More Info About Extra 30% Off In Cart!";
const FALL = "30% Off Fall Essentials Shop Men's Fall Outerwear";
const TB = "https://www.timberland.com/en-us/p/footwear-0100/";

(async () => {
  // ── Sales copy is not a brand; brands are ─────────────────────────────────
  for (const line of [EXCLUDED, WIDES, CART, FALL, "New", "Sale", "Sold out", "Free Shipping & Returns", "$180.00", "Знижка 20%"]) {
    check(`sales copy: "${line}"`, isSalesCopy(line), true);
  }
  for (const brand of [
    "Timberland", "Timberland®", "Off-White", "New Balance", "Free People", "ONLY", "Save The Duck",
    "Comme des Garçons Homme Plus", "A.P.C.", "1017 ALYX 9SM", "Polo Ralph Lauren", "Stone Island Shadow Project",
    "The North Face", "Dr. Martens", "Levi's",
  ]) {
    check(`a brand: "${brand}"`, isSalesCopy(brand), false);
  }

  // What an earlier run left on the Brands list is not a brand to recognise.
  const vocabulary = brandModule.brandVocabulary(["Timberland", EXCLUDED, WIDES], [CART, "Timberland®", "Nike"]);
  check("the Brands list and the catalogue, without their sales copy", vocabulary, ["Timberland", "Nike"]);

  // ── The brand an import decides ───────────────────────────────────────────
  const known = ["Timberland", "Nike", "Jordan", "The North Face", CART, WIDES];
  const decide = (stated, name, host = "www.timberland.com", extra = {}) =>
    decideBrand({ stated, name, host, known, weak: true, ...extra });
  check("Timberland®'s name beats the sales line, even one an earlier run put on the Brands list",
    decide(CART, "Men's Timberland® Classic 6-Inch Waterproof Boot").brand, "Timberland");
  {
    const d = decide(WIDES, "Men's Waterproof Field Boot");
    check("a name with no brand, on timberland.com: the store's own brand", d.brand, "Timberland");
    check("and the decision says the store decided it", d.fromShop, true);
  }
  check("declared, not printed, and still sales copy: not a brand",
    decideBrand({ stated: EXCLUDED, name: "Men's Euro Hiker", host: "www.timberland.com", known }).brand, "Timberland");
  check("the store's own brand on a country site (timberland.co.uk)", decide(EXCLUDED, "Men's Euro Hiker", "www.timberland.co.uk").brand, "Timberland");
  check("thenorthface.com is The North Face's", decide("", "Men's Waterproof Shell", "www.thenorthface.com").brand, "The North Face");
  check("a trademark sign is not part of the brand", decideBrand({ stated: "Timberland®", name: "Men's Euro Hiker", host: "shop.example", known }).brand, "Timberland");
  check("a marketplace is no maker: nothing named, nothing guessed", decide("", "Wool Overcoat", "www.farfetch.com").brand, "");
  check("a marketplace's name given as the brand is no brand", decideBrand({ stated: "GOAT", name: "Wool Overcoat", host: "www.goat.com", known: [...known, "GOAT"] }).brand, "");
  check("an admin's rule that the store is not the brand's own: no guess from its address",
    decide(WIDES, "Men's Waterproof Field Boot", "www.timberland.com", { ownShop: false }).brand, "");
  check("a brand the page declares stands on the brand's own site too",
    decideBrand({ stated: "Vibram", name: "Men's Field Boot", host: "www.timberland.com", known: [...known, "Vibram"] }).brand, "Vibram");
  check("a printed brand that is the store's other name stands (Jordan on nike.com)",
    decide("Jordan", "Flight Essentials Hoodie", "www.nike.com").brand, "Jordan");
  check("a known maker printed on another maker's site, its model in the name: that maker",
    decide("Converse", "Run Star Hike Platform", "www.nike.com", { known: [...known, "Converse"] }).brand, "Converse");
  check("a known maker printed there, nothing in the name: still that maker",
    decide("Converse", "Weapon CX", "www.nike.com", { known: [...known, "Converse"] }).brand, "Converse");
  check("an unknown word printed on a maker's own site, nothing in the name: the site",
    decide("Gore-Tex", "Men's Waterproof Field Boot").brand, "Timberland");
  check("a name naming another maker on the brand's site: the name",
    decide("", "Converse Chuck 70 Hi", "www.nike.com", { known: [...known, "Converse"] }).brand, "Converse");

  // ── The extractor drops the sales line, and marks what was only printed ───
  {
    const html = "<html><head><title>Men's Euro Hiker | Timberland</title></head><body><h1>Men's Euro Hiker</h1></body></html>";
    const raw = extractProduct(html, null, `${TB}mens-euro-hiker`, { brandText: EXCLUDED });
    check("printed sales copy: no brand from the page", raw.brand ?? "", "");
    const raw2 = extractProduct(html, null, `${TB}mens-euro-hiker`, { brandText: "Timberland" });
    check("printed brand: kept, and marked as printed", { brand: raw2.brand, brandFromText: raw2.brandFromText }, { brand: "Timberland", brandFromText: true });
    check("and the mark reaches the importer", normalizeExtract(raw2, `${TB}mens-euro-hiker`).brandFromText, true);
  }

  // ── Colour groups: a card saved with sales copy is a card with no brand ────
  const euro = (brand, colors) => ({ id: "x", brand, name: "Men's Euro Hiker", colors, category: "shoes" });
  check("Timberland's Euro Hiker and one saved under the sales line: one piece",
    isSamePieceByName({ brand: "Timberland", name: "Men's Euro Hiker", colors: ["Black"], category: "shoes" }, euro(EXCLUDED, ["Brown"])), true);
  check("two real makers with one name are still two pieces",
    isSamePieceByName({ brand: "Timberland", name: "Men's Euro Hiker", colors: ["Black"], category: "shoes" }, euro("Dr. Martens", ["Brown"])), false);

  // ── Through the importer: three colourways of one boot ────────────────────
  const piece = (color, slug, brand, extra = {}) => ({
    name: "Men's Euro Hiker",
    brand,
    brandFromText: true,
    category: "shoes",
    colors: [color],
    price: 180,
    currency: "USD",
    imageUrl: `https://images.timberland.com/is/image/timberland/${slug}-hero`,
    images: [],
    ...extra,
  });
  const groupOf = () => {
    const rows = db.rows();
    const groups = new Set(rows.map((r) => r.variant_group_id));
    return {
      cards: rows.length,
      oneGroup: groups.size === 1 && !groups.has(undefined) && !groups.has(null),
      primaries: rows.filter((r) => r.is_group_primary === true).length,
      brands: [...new Set(rows.map((r) => r.brand))],
    };
  };

  // The run in the screenshots: wheat and black under Timberland, brown under the sales line.
  db.reset([], { live: true, brands: ["Timberland"] });
  await importParsedProduct(piece("Wheat Nubuck", "euro-wheat", "Timberland"), `${TB}mens-euro-hiker-wheat`, {});
  await importParsedProduct(piece("Black Full-Grain", "euro-black", "Timberland"), `${TB}mens-euro-hiker-black`, {});
  const brown = await importParsedProduct(piece("Medium Brown Nubuck", "euro-brown", EXCLUDED), `${TB}mens-euro-hiker-brown`, {});
  check("three colourways, the brown one under the sales line: one group, one lead, one brand",
    groupOf(), { cards: 3, oneGroup: true, primaries: 1, brands: ["Timberland"] });
  check("the brown one's row says where its brand came from", /brand Timberland from the store, its own site \(page said Excluded/.test(brown.brandNote || ""), true);
  check("the sales line never joins the Brands list", db.brandsAdded(), []);

  // A catalogue the old run left behind: the brown card under the sales line,
  // the wheat and black ones grouped without it.
  const left = [
    { id: "brown", source_url: `${TB}mens-euro-hiker-brown`, name: "Men's Euro Hiker", brand: EXCLUDED, colors: ["Medium Brown Nubuck"], category: "shoes", retailers: [] },
    { id: "black", source_url: `${TB}mens-euro-hiker-black`, name: "Men's Euro Hiker", brand: "Timberland", colors: ["Black Full-Grain"], category: "shoes", retailers: [], variant_group_id: "g1", is_group_primary: true },
    { id: "wheat", source_url: `${TB}mens-euro-hiker-wheat`, name: "Men's Euro Hiker", brand: "Timberland", colors: ["Wheat Nubuck"], category: "shoes", retailers: [], variant_group_id: "g1", is_group_primary: false },
  ];
  db.reset(left, { live: true, brands: ["Timberland", EXCLUDED, WIDES] });
  await importParsedProduct(piece("Medium Brown Nubuck", "euro-brown", EXCLUDED), `${TB}mens-euro-hiker-brown`, {});
  const healed = db.rows().find((r) => r.id === "brown");
  check("collecting the brown page again: its card gets Timberland and joins the group",
    { brand: healed.brand, group: healed.variant_group_id, primary: healed.is_group_primary }, { brand: "Timberland", group: "g1", primary: false });
  check("and the group keeps its one lead", groupOf().primaries, 1);

  // A fourth colour imported beside the old brown card, before anything is re-collected.
  db.reset(left.map((r) => ({ ...r })), { live: true, brands: ["Timberland"] });
  await importParsedProduct(piece("Rust Nubuck", "euro-rust", "Timberland"), `${TB}mens-euro-hiker-rust`, {});
  check("a new colour joins the old brown card too, whatever brand that card was saved under",
    groupOf(), { cards: 4, oneGroup: true, primaries: 1, brands: [EXCLUDED, "Timberland"] });

  // The field boots of the screenshot: every page with a sales line, no brand in the name.
  db.reset([], { live: true, brands: ["Timberland"] });
  const boot = (color, line) => ({ ...piece(color, `field-${color}`, line), name: "Men's Waterproof Field Boot" });
  await importParsedProduct(boot("Black", EXCLUDED), `${TB}mens-waterproof-field-boot-black`, {});
  await importParsedProduct(boot("Wheat", WIDES), `${TB}mens-waterproof-field-boot-wheat`, {});
  check("Men's Waterproof Field Boot: Timberland on both, one group", groupOf(), { cards: 2, oneGroup: true, primaries: 1, brands: ["Timberland"] });

  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
