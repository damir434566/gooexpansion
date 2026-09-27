/**
 * A second store's page of a piece the catalogue already has adds its link to
 * that card — every link the card had stays — and makes no second card.
 *
 * Runs the real importer against the recording fake Supabase, like
 * test-same-model.js, on the shapes real stores send that still made a second
 * card: an article code in the title, "Nike" on one site and "Jordan" on the
 * other, no brand in the markup, the colourway in the title, a price the page
 * named no currency for, a deep sale, one barcode padded two ways, the same
 * page under another address. And the one that lost a link: two sites both
 * called "Nike".
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
const { withRetailer } = require(path.join(COMPILED, "lib", "server", "parser", "same-item.js"));
const { findDuplicateGroups, mergeCardsPatch } = require(path.join(COMPILED, "lib", "server", "duplicates.js"));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => (cond ? pass++ : failures.push(`${name}${detail ? `\n     ${detail}` : ""}`));

let seq = 0;
/** A card the first store made. `stores` adds more places to buy it. */
function card(brand, name, o = {}) {
  seq++;
  const url = o.url ?? `https://first.example/p/${seq}`;
  return {
    id: `c${seq}`,
    brand,
    name,
    category: o.category ?? "footwear",
    colors: o.colors ?? ["White"],
    price_min: o.price ?? 100,
    price_max: o.price ?? 100,
    currency: "USD",
    images: [`${url}.jpg`],
    source_url: url,
    retailers: [
      { name: o.store ?? "First", url, price: o.price ?? 100, currency: "USD" },
      ...(o.stores ?? []),
    ],
    ...(o.row ?? {}),
  };
}

/** A second store's page, as the parser hands it to the importer. */
function page(brand, name, o = {}) {
  return {
    name,
    brand,
    category: o.category ?? "footwear",
    colors: o.colors ?? ["White"],
    price: o.price ?? 105,
    currency: o.currency ?? "USD",
    images: ["https://second.example/img/1.jpg"],
    imageUrl: "https://second.example/img/1.jpg",
    ...(o.extra ?? {}),
  };
}

const urlsOf = (list) => (list ?? []).map((r) => r.url);

/** The page joins `target`: no insert, the link added, every old link kept. */
async function joins(title, rows, incoming, url, target, opts = {}) {
  db.reset(rows);
  const r = await importParsedProduct(incoming, url, opts);
  const inserted = db.inserts().length;
  ok(`${title}: no second card`, inserted === 0, `inserted ${inserted}; ${JSON.stringify({ merged: r.mergedInto, note: r.linkNote, skipped: r.skipped, err: r.error })}`);
  ok(`${title}: joins the card`, r.productId === target.id, `productId ${r.productId}`);
  const upd = db.updates().find((u) => u.filters.some((f) => f[2] === target.id) && u.row.retailers);
  const after = urlsOf(upd?.row.retailers);
  ok(`${title}: this store's link is on the card`, after.includes(url), JSON.stringify(after));
  const before = urlsOf(target.retailers).filter((u) => new URL(u).hostname !== new URL(url).hostname);
  ok(`${title}: every other store's link is still there`, before.every((u) => after.includes(u)), `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  return { r, upd };
}

async function newCard(title, rows, incoming, url, opts = {}) {
  db.reset(rows);
  const r = await importParsedProduct(incoming, url, opts);
  ok(`${title}: a card of its own`, db.inserts().length === 1 && !r.mergedInto, JSON.stringify({ merged: r.mergedInto, updated: r.updated }));
  return r;
}

(async () => {
  console.log("— what a second store's title adds —");
  {
    const c = card("Nike", "Nike Air Force 1 '07", { price: 115 });
    await joins("the article code in the title", [c], page("Nike", "Кросівки чоловічі Nike Air Force 1 '07 CW2288-111", { colors: ["Білий"], price: 110 }), "https://intertop.example/p/af1", c);
  }
  {
    const c = card("adidas", "Samba OG Shoes", { colors: ["Cloud White / Core Black / Gum"] });
    await joins("the colourway in the title", [c], page("adidas", "adidas Samba OG 'Cloud White Core Black'", { price: 110 }), "https://second.example/samba", c);
  }
  {
    const c = card("Carhartt WIP", "Detroit Jacket", { category: "outerwear", colors: ["Black"], price: 200 });
    await joins("the colour's finish in the title", [c], page("Carhartt WIP", "Carhartt WIP Detroit Jacket Black Rinsed", { category: "outerwear", colors: ["Black (rinsed)"], price: 210 }), "https://second.example/detroit", c);
  }
  {
    const c = card("New Balance", "New Balance 9060", { colors: ["Grey"], price: 150 });
    await joins("the maker's code instead of words", [c], page("New Balance", "New Balance 9060 U9060EEB NEW", { colors: ["Grey"], price: 160 }), "https://second.example/9060", c);
  }

  console.log("— the brand —");
  {
    const c = card("Jordan", "Air Jordan 1 Retro High OG", { colors: ["Black/White"], price: 180 });
    await joins("Nike on one site, Jordan on the other", [c], page("Nike", "Nike Air Jordan 1 Retro High OG", { colors: ["White/Black"], price: 190 }), "https://second.example/aj1", c);
  }
  {
    const c = card("Nike", "Nike Air Max 90", { price: 130 });
    await joins("a page naming no brand", [c], page("", "Кросівки Air Max 90", { price: 130 }), "https://second.example/am90", c);
  }
  {
    const c = card("", "Bullet Hole Jeans", { category: "jeans", colors: ["Blue"], price: 500 });
    await joins("a card made without a brand", [c], page("Mowalola", "Mowalola Bullet Hole Jeans", { category: "jeans", colors: ["Blue"], price: 520 }), "https://second.example/jeans", c);
  }
  {
    const c = card("Levi's", "Levi's 501 Original Jeans", { category: "jeans", colors: ["Blue"], price: 90 });
    await joins("Levi's and Levis", [c], page("Levis", "Levis 501 Original Jeans", { category: "jeans", colors: ["Blue"], price: 95 }), "https://second.example/501", c);
  }

  console.log("— the price —");
  {
    const c = card("adidas", "Samba OG", { price: 100 });
    const { upd } = await joins("a page that named no currency", [c], page("adidas", "adidas Samba OG", { price: 4200, currency: "" }), "https://second.example/samba-ua", c);
    ok("  …and 4200 of it is not a dollar price on the card", !(upd?.row.price_max > 1000), JSON.stringify(upd?.row));
  }
  {
    const c = card("Nike", "Nike Air Max 90", { price: 130 });
    await joins("a 70%-off sale", [c], page("Nike", "Nike Air Max 90", { price: 40 }), "https://second.example/am90-sale", c);
  }

  console.log("— the codes, however they are written —");
  {
    const c = card("Nike", "Some Other Title", { row: { gtin: "0012345678905" } });
    await joins("one barcode padded two ways", [c], page("Nike", "Totally Different Name", { extra: { gtin: "012345678905" } }), "https://second.example/gtin", c);
  }
  {
    const c = card("Nike", "Some Other Title", { row: { mpn: "CW2288-111" } });
    await joins("one part number punctuated two ways", [c], page("Nike", "Totally Different Name", { extra: { mpn: "cw2288 111" } }), "https://second.example/mpn", c);
  }

  console.log("— the same page, found again —");
  {
    const linked = "https://second.example/p/linked";
    const c = card("Nike", "Renamed By The Admin", { stores: [{ name: "Second", url: linked, price: 90, currency: "USD" }] });
    const { upd } = await joins("a page already linked to a card, card since renamed", [c], page("Nike", "Nike Air Max 90"), linked, c);
    ok("  …its store is not listed twice", urlsOf(upd?.row.retailers).filter((u) => u === linked).length === 1, JSON.stringify(urlsOf(upd?.row.retailers)));
  }
  {
    const c = card("Nike", "Nike Air Max 90", { url: "https://second.example/am90" });
    db.reset([c]);
    const r = await importParsedProduct(page("Nike", "Nike Air Max 90"), "https://www.second.example/am90/?srsltid=AfmBOoq", {});
    ok("a tracking tag and a trailing slash: the card is updated, none made", db.inserts().length === 0 && r.productId === c.id, JSON.stringify(r));
  }
  {
    const c = card("Nike", "Nike Air Max 90", { url: "https://shop.example/products/am90", colors: ["White"] });
    const { upd } = await joins("the store's page through a collection, same colour", [c], page("Nike", "Nike Air Max 90", { colors: ["White"] }), "https://shop.example/collections/men/products/air-max-90-white", c);
    ok("  …the store's entry replaced, not doubled", (upd?.row.retailers ?? []).length === 1, JSON.stringify(upd?.row.retailers));
  }

  console.log("— no link is ever lost —");
  {
    const both = withRetailer([{ name: "Nike", url: "https://nike.com/t/af1" }], { name: "Nike", url: "https://nike.ua/t/af1" });
    ok("two sites both called Nike: both links", urlsOf(both).join(" ") === "https://nike.com/t/af1 https://nike.ua/t/af1", JSON.stringify(both));
    const again = withRetailer(both, { name: "Nike", url: "https://nike.ua/t/af1", price: 99 });
    ok("the same site again: its entry refreshed, not doubled", again.length === 2 && again[1].price === 99, JSON.stringify(again));
    const manual = withRetailer([{ name: "Intertop" }], { name: "Intertop", url: "https://intertop.ua/p/1" });
    ok("an entry without an address is known by its name", manual.length === 1, JSON.stringify(manual));
  }
  {
    const c = card("Nike", "Nike Air Force 1 '07", { stores: [{ name: "Intertop", url: "https://intertop.ua/p/af1" }] });
    await joins("a third store joins a card with two", [c], page("Nike", "Nike Air Force 1 '07"), "https://answear.example/p/af1", c);
  }
  {
    // Re-collecting the first store's own page used to keep only the stores
    // whose NAME differed from its own: nike.ua, also "Nike", was dropped.
    const c = card("Nike", "Nike Air Force 1 '07", { url: "https://nike.com/t/af1", store: "Nike", stores: [{ name: "Nike", url: "https://nike.ua/t/af1", price: 110, currency: "USD" }] });
    db.reset([c]);
    await importParsedProduct(page("Nike", "Nike Air Force 1 '07"), "https://nike.com/t/af1", {});
    const upd = db.updates().find((u) => u.row.retailers);
    ok("re-collecting nike.com keeps nike.ua", urlsOf(upd?.row.retailers).includes("https://nike.ua/t/af1"), JSON.stringify(upd?.row.retailers));
  }
  {
    const keep = { id: "k", retailers: [{ name: "Nike", url: "https://nike.com/t/af1" }] };
    const other = { id: "o", retailers: [{ name: "Nike", url: "https://nike.ua/t/af1" }] };
    const { patch } = mergeCardsPatch(keep, [other]);
    ok("merging duplicates keeps the other card's same-named store", urlsOf(patch.retailers).includes("https://nike.ua/t/af1"), JSON.stringify(patch));
  }

  console.log("— links-only runs join the same way —");
  {
    const c = card("Nike", "Nike Air Force 1 '07", { price: 115 });
    await joins("links only, article code in the title", [c], page("Nike", "Nike Air Force 1 '07 CW2288-111", { price: 110 }), "https://intertop.example/p/af1-lo", c, { linksOnly: true });
  }

  console.log("— and what is still another card —");
  await newCard("Air Max 90 Essential is another model", [card("Nike", "Nike Air Max 90", { price: 130 })], page("Nike", "Nike Air Max 90 Essential", { price: 130 }), "https://second.example/am90e");
  await newCard("another colour", [card("adidas", "Samba OG Shoes", { colors: ["White"] })], page("adidas", "adidas Samba OG", { colors: ["Green"] }), "https://second.example/samba-green");
  await newCard(
    "the same store, another colour",
    [card("Nike", "Nike Air Max 90", { url: "https://shop.example/p/am90-white", colors: ["White"] })],
    page("Nike", "Nike Air Max 90", { colors: ["Black"] }),
    "https://shop.example/p/am90-black",
  );
  {
    const c = card("Nike", "Nike Air Max 90", { url: "https://shop.example/p/am90-white", colors: ["White"] });
    await newCard("the same store, no colour to tell", [c], page("Nike", "Nike Air Max 90", { colors: [] }), "https://shop.example/p/am90-x");
    ok("  …and the card's link to that store is untouched", !db.updates().some((u) => u.filters.some((f) => f[2] === c.id) && u.row.retailers));
  }
  await newCard("a brandless page's lone word", [card("etnies", "Emerson", { colors: ["Black"], price: 70 })], page("", "Emerson", { colors: ["Black"], price: 70 }), "https://second.example/emerson");
  await newCard("a brandless page's generic name", [card("Stussy", "Stussy Classic Logo Tee", { category: "tops", colors: ["White"], price: 50 })], page("", "Classic Logo Tee", { category: "tops", colors: ["White"], price: 50 }), "https://second.example/tee");
  await newCard("two brands, one model name", [card("adidas", "Superstar", { colors: ["White"] })], page("Puma", "Puma Superstar", { colors: ["White"] }), "https://second.example/superstar");
  await newCard("Jordan 4 Retro is not Jordan 4 Retro Toro Bravo", [card("Jordan", "Jordan 4 Retro", { colors: ["Red"], price: 210 })], page("Jordan", "Jordan 4 Retro Toro Bravo", { colors: ["Red"], price: 210 }), "https://second.example/j4-toro");
  await newCard("a short model name is not a code", [card("adidas", "ZX750 Shoes", { colors: ["Blue"] })], page("adidas", "ZX8000 Shoes", { colors: ["Blue"] }), "https://second.example/zx");

  console.log("— the Duplicates screen sees the same —");
  {
    const row = (id, brand, name, host, extra = {}) => ({
      id, brand, name,
      category: "footwear",
      sourceUrl: `https://${host}/p/${id}`,
      priceMin: extra.price ?? 180,
      retailers: [{ name: host, url: `https://${host}/p/${id}`, price: extra.price ?? 180, currency: "USD" }],
      colors: extra.colors ?? ["Black/White"],
      images: [],
      createdAt: null,
    });
    const groups = findDuplicateGroups([
      row("n1", "Jordan", "Air Jordan 1 Retro High OG", "nike.com"),
      row("n2", "Nike", "Nike Air Jordan 1 Retro High OG", "reseller.example"),
      row("f1", "Nike", "Nike Air Force 1 '07", "nike.com", { colors: ["White"], price: 115 }),
      row("f2", "Nike", "Кросівки Nike Air Force 1 '07 CW2288-111", "intertop.ua", { colors: ["Білий"], price: 110 }),
    ]).map((g) => [...g.ids].sort().join("+"));
    ok("Jordan / Nike found as one item", groups.includes("n1+n2"), JSON.stringify(groups));
    ok("a code in one title found as one item", groups.includes("f1+f2"), JSON.stringify(groups));
  }

  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
