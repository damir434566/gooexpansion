/**
 * SSENSE, at the import: the main photo a card keeps, and one card per page.
 *
 * Every piece of the SSENSE run came back as two rows: "New" and, beside it,
 * "Failed — duplicate key value violates unique constraint
 * products_source_url_idx". Two imports of one page ran at once (two bridges in
 * the collect tab passed each request twice), both looked for the page's card,
 * neither found it, and the second insert met the unique address. And the card
 * kept a main photo our server could not download, as a broken image.
 *
 * Runs the real importer and mirror (`verification/compiled`, ./compile.sh)
 * against the recording fake Supabase, with the network stubbed: no store is
 * asked for anything.
 */
const path = require("path");
const Module = require("module");
const dns = require("node:dns/promises");

const COMPILED = path.join(__dirname, "compiled");
const FAKE = path.join(__dirname, "fake-supabase.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/supabase") return FAKE;
  if (request.startsWith("@/")) request = path.join(COMPILED, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

const db = require(FAKE);
process.env.SUPABASE_URL = db.STORAGE_ORIGIN;
// Every CDN host is a public one here; the address check stays on.
dns.lookup = async () => [{ address: "93.184.215.14", family: 4 }];

const { mirrorProductImages } = require(path.join(COMPILED, "lib", "server", "storage", "product-images.js"));
const { importParsedProduct } = require(path.join(COMPILED, "lib", "server", "parser", "import-product.js"));

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

const ID = "252342M223005";
const TEMPLATE = `https://res.cloudinary.com/ssenseweb/image/upload/__IMAGE_PARAMS__/${ID}_1.jpg`;
const PHOTO = (n) => `https://img.ssensemedia.com/images/b_white,g_center,f_auto,q_auto:best/${ID}_${n}/balenciaga-black-venom-boots.jpg`;
const PAGE = "https://www.ssense.com/en-gb/men/product/balenciaga/black-venom-boots/18128871";

/** What the CDN answers, by address: a status, or a photo. */
let answers = new Map();
global.fetch = async (input) => {
  const url = String(input instanceof URL ? input.href : input?.url ?? input);
  const status = answers.get(url) ?? 200;
  if (status !== 200) return new Response("no", { status, headers: { "content-type": "text/plain" } });
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
};
const stored = (u) => typeof u === "string" && u.startsWith(`${db.STORAGE_ORIGIN}/storage/v1/object/public/product-images/`);

(async () => {
  console.log("— a main photo the CDN does not have —");
  {
    db.reset([], { storage: true });
    answers = new Map([[TEMPLATE, 400]]);
    const r = await mirrorProductImages({ imageUrl: TEMPLATE, images: [TEMPLATE, PHOTO(2), PHOTO(3)] });
    ok("main photo is one we stored", stored(r.imageUrl), r.imageUrl);
    check("the broken address is not kept", [r.imageUrl, ...r.images].includes(TEMPLATE), false);
    check("two photos, the main one first", r.images.length === 2 && r.images[0] === r.imageUrl, true);
    check("counted as copied and failed", [r.mirrored, r.failed], [2, 1]);
  }

  console.log("— a main photo the CDN refused, not denied —");
  {
    db.reset([], { storage: true });
    answers = new Map([[PHOTO(1), 403]]);
    const r = await mirrorProductImages({ imageUrl: PHOTO(1), images: [PHOTO(1), PHOTO(2), PHOTO(3)] });
    ok("main photo is one we stored", stored(r.imageUrl), r.imageUrl);
    check("the refused one is still on the card, after it", r.images.indexOf(PHOTO(1)), 1);
    check("three photos", r.images.length, 3);
  }

  console.log("— nothing came through —");
  {
    db.reset([], { storage: true });
    answers = new Map([[TEMPLATE, 404], [PHOTO(2), 404]]);
    const r = await mirrorProductImages({ imageUrl: TEMPLATE, images: [TEMPLATE, PHOTO(2)] });
    check("everything kept as it was", [r.imageUrl, r.images], [TEMPLATE, [TEMPLATE, PHOTO(2)]]);
  }

  console.log("— the main photo came through —");
  {
    db.reset([], { storage: true });
    answers = new Map([[PHOTO(2), 404]]);
    const r = await mirrorProductImages({ imageUrl: PHOTO(1), images: [PHOTO(1), PHOTO(2), PHOTO(3)] });
    ok("main photo stored", stored(r.imageUrl), r.imageUrl);
    check("order kept, the missing one dropped", r.images.length === 2 && r.images[0] === r.imageUrl && stored(r.images[1]), true);
  }

  const piece = {
    name: "Black Venom Boots",
    brand: "Balenciaga",
    category: "footwear",
    price: 1695,
    currency: "GBP",
    imageUrl: PHOTO(1),
    images: [PHOTO(1), PHOTO(2)],
  };

  console.log("— two imports of one page at once —");
  {
    // The other import committed the card after this one looked for it.
    db.reset([], { lateRows: [{ id: "card-1", name: "Black Venom Boots", brand: "Balenciaga", source_url: PAGE, retailers: [] }] });
    const r = await importParsedProduct({ ...piece }, PAGE, {});
    ok("not a failure", r.ok, r.error);
    check("the card the other import made", r.productId, "card-1");
    check("reported as updated, not new", r.updated, true);
    ok("and says why", /another import of this page/.test(r.linkNote ?? ""), r.linkNote);
  }

  console.log("— a duplicate key that is not this page's card —");
  {
    // Nothing at this address afterwards: a real failure, reported as one.
    db.reset([], { lateRows: [{ id: "x", source_url: PAGE, invisible: true }] });
    const r = await importParsedProduct({ ...piece }, PAGE, {});
    check("still a failure", [r.ok, r.error], [false, 'duplicate key value violates unique constraint "products_source_url_idx"']);
  }

  console.log("");
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
