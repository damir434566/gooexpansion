/**
 * A store whose photos are missing or wrong: its pages add their link to a
 * piece the catalogue already has, and never make a card of their own.
 *
 * Runs the real `importParsedProduct` against a fake Supabase that answers from
 * a small in-memory catalogue and records every write, so what the importer
 * would do to the database is what is checked.
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
const { importParsedProduct } = require(path.join(COMPILED, "lib", "server", "parser", "import-product.js"));

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
};
const ok = (name, cond, detail = "") => (cond ? pass++ : failures.push(`${name}${detail ? `\n     ${detail}` : ""}`));

const EXISTING = {
  id: "p1",
  name: "Samba OG Shoes",
  brand: "adidas",
  category: "footwear",
  colors: ["White"],
  price_min: 100,
  price_max: 100,
  currency: "USD",
  images: ["https://assets.adidas.com/samba-1.jpg", "https://assets.adidas.com/samba-2.jpg"],
  // Empty on purpose: an ordinary merge would fill these from the stock page,
  // and link-only must not.
  description: "",
  material: "",
  sizes: ["40", "41"],
  source_url: "https://www.adidas.com/samba-og",
  retailers: [{ name: "adidas", url: "https://www.adidas.com/samba-og", price: 100, currency: "USD", availability: "in stock", isOfficial: true }],
};

const STOCK_PAGE = {
  name: "Samba OG Shoes",
  brand: "adidas",
  category: "footwear",
  colors: ["White"],
  price: 90,
  currency: "USD",
  description: "Stock description that must not overwrite.",
  material: "Suede",
  sizes: ["39"],
  images: ["https://stock-x.example/banner.jpg", "https://stock-x.example/size-chart.jpg"],
  imageUrl: "https://stock-x.example/banner.jpg",
};

(async () => {
  console.log("— a piece the catalogue already has: only the link is added —");
  {
    db.reset([EXISTING]);
    const r = await importParsedProduct(STOCK_PAGE, "https://stock-x.example/p/samba-og", { linkOnly: true });
    check("ok", r.ok, true);
    check("outcome", r.linkOnly, "linked");
    check("into the existing product", r.mergedInto, "p1");
    check("no row inserted", db.inserts().length, 0);
    const updates = db.updates();
    check("one update", updates.length, 1);
    const patch = updates[0]?.row ?? {};
    ok("only link and price columns written", Object.keys(patch).every((k) => /^(retailers|price_min|price_max|price_min_usd|price_max_usd)$/.test(k)), JSON.stringify(Object.keys(patch)));
    ok("the stock link is on the product", (patch.retailers ?? []).some((x) => x.url === "https://stock-x.example/p/samba-og"));
    ok("the brand's own link is kept", (patch.retailers ?? []).some((x) => x.url === EXISTING.source_url));
    check("price range widened to the cheaper store", patch.price_min, 90);
    ok("no photos written", !("images" in patch) && !("image_url" in patch));
    ok("description untouched", !("description" in patch));
  }

  console.log("— no such piece yet: nothing is created —");
  {
    db.reset([EXISTING]);
    const r = await importParsedProduct(
      { ...STOCK_PAGE, name: "Gazelle Indoor Shoes" },
      "https://stock-x.example/p/gazelle",
      { linkOnly: true },
    );
    check("ok", r.ok, true);
    check("outcome", r.linkOnly, "no-match");
    check("no product id", r.productId, null);
    check("no insert", db.inserts().length, 0);
    check("no update", db.updates().length, 0);
  }

  console.log("— the page already has its own card: left alone —");
  {
    db.reset([{ ...EXISTING, id: "p2", source_url: "https://stock-x.example/p/samba-og" }]);
    const r = await importParsedProduct(STOCK_PAGE, "https://stock-x.example/p/samba-og", { linkOnly: true });
    check("outcome", r.linkOnly, "own-row");
    check("no write", db.inserts().length + db.updates().length, 0);
  }

  console.log("— without link-only, the same page still makes a card —");
  {
    db.reset([EXISTING]);
    const r = await importParsedProduct(
      { ...STOCK_PAGE, name: "Gazelle Indoor Shoes" },
      "https://stock-x.example/p/gazelle",
      {},
    );
    check("ok", r.ok, true);
    check("not link-only", r.linkOnly, undefined);
    check("one insert", db.inserts().length, 1);
    ok("with its photos", (db.inserts()[0]?.row.images ?? []).length === 2);
  }

  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
