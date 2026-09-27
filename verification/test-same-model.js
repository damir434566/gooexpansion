/**
 * The same model from a second store joins its card as a link, instead of
 * becoming a second card.
 *
 * Runs the real importer against the recording fake Supabase: the first store's
 * card is in the catalogue, the second store's page is imported, and what must
 * happen is an update of that card's retailers — no insert.
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
const ok = (name, cond, detail = "") => (cond ? pass++ : failures.push(`${name}${detail ? `\n     ${detail}` : ""}`));

let seq = 0;
function card(brand, name, extra = {}) {
  seq++;
  return {
    id: `c${seq}`,
    brand,
    name,
    category: extra.category ?? "outerwear",
    colors: extra.colors ?? ["Black"],
    price_min: extra.price ?? 200,
    price_max: extra.price ?? 200,
    currency: "USD",
    images: [`https://first.example/p/${seq}.jpg`],
    source_url: `https://first.example/p/${seq}`,
    retailers: [{ name: "First", url: `https://first.example/p/${seq}`, price: extra.price ?? 200, currency: "USD" }],
    ...extra.row,
  };
}

function page(brand, name, extra = {}) {
  return {
    name,
    brand,
    category: extra.category ?? "outerwear",
    colors: extra.colors ?? ["Black"],
    price: extra.price ?? 210,
    currency: "USD",
    images: ["https://second.example/img/1.jpg"],
    imageUrl: "https://second.example/img/1.jpg",
  };
}

async function joins(title, rows, incoming, url, targetId) {
  db.reset(rows);
  const r = await importParsedProduct(incoming, url, {});
  const inserted = db.inserts().length;
  ok(`${title}: no second card`, inserted === 0, `inserted ${inserted}; ${JSON.stringify({ merged: r.mergedInto, err: r.error })}`);
  ok(`${title}: the link joins the existing card`, r.mergedInto === targetId, `mergedInto ${r.mergedInto}`);
  const upd = db.updates().find((u) => u.filters.some((f) => f[2] === targetId));
  ok(`${title}: the second store is on the card`, !!upd && (upd.row.retailers ?? []).some((x) => x.url === url));
}

async function staysApart(title, rows, incoming, url) {
  db.reset(rows);
  const r = await importParsedProduct(incoming, url, {});
  ok(`${title}: not merged`, !r.mergedInto, `mergedInto ${r.mergedInto}`);
}

(async () => {
  console.log("— the brand spelled another way —");
  {
    const c = card("adidas", "Samba OG Shoes", { category: "footwear", colors: ["White"], price: 100 });
    await joins("adidas / adidas Originals", [c], page("adidas Originals", "adidas Originals Samba OG", { category: "footwear", colors: ["White"], price: 110 }), "https://second.example/samba-og", c.id);
  }
  {
    const c = card("Carhartt WIP", "Detroit Jacket", { colors: ["Black"] });
    await joins("Carhartt WIP / Carhartt", [c], page("Carhartt", "Carhartt Detroit Jacket", { colors: ["Black"] }), "https://second.example/detroit", c.id);
  }
  {
    const c = card("The North Face", "Nuptse 1996 Retro Jacket");
    await joins("The North Face / North Face", [c], page("North Face", "1996 Retro Nuptse Jacket"), "https://second.example/nuptse", c.id);
  }

  console.log("— the name a little longer —");
  {
    const c = card("Jordan", "Jordan 4 Retro Toro Bravo", { category: "footwear", colors: ["Red"], price: 210 });
    await joins(
      "Air Jordan 4 Retro 'Toro Bravo' (2026)",
      [c],
      page("Jordan", "Air Jordan 4 Retro 'Toro Bravo' (2026)", { category: "footwear", colors: ["Red"], price: 240 }),
      "https://stockx.com/air-jordan-4-retro-toro-bravo-2026",
      c.id,
    );
  }

  console.log("— a brand with more cards than one read returns —");
  {
    const many = [];
    for (let i = 0; i < 600; i++) many.push(card("Nike", `Filler Tee ${i}`, { category: "tops" }));
    const target = card("Nike", "Windrunner Hooded Jacket 2026", { colors: ["Black"] });
    await joins("card number 601", [...many, target], page("Nike", "Nike Windrunner Hooded Jacket 2026", { colors: ["Black"] }), "https://second.example/windrunner", target.id);
  }

  console.log("— what real catalogues look like —");
  {
    const c = card("Nike", "Dunk Low Retro", { category: "footwear", colors: ["White", "Black"], price: 120 });
    await joins("colours listed in the other order", [c], page("Nike", "Nike Dunk Low Retro", { category: "footwear", colors: ["Black", "White"], price: 130 }), "https://second.example/dunk", c.id);
  }
  {
    const c = card("", "Stussy Basic Logo Hoodie 2026", { category: "tops", colors: ["Black"], price: 150 });
    await joins("a card saved without a brand", [c], page("Stussy", "Basic Logo Hoodie 2026", { category: "tops", colors: ["Black"], price: 160 }), "https://second.example/stussy-hoodie", c.id);
  }
  {
    const c = card("Stone Island", "Ghost Piece Crewneck Sweatshirt 2026", { category: "knitwear", colors: ["Navy"], price: 400 });
    await joins("one store says knitwear, the other tops", [c], page("Stone Island", "Ghost Piece Crewneck Sweatshirt 2026", { category: "tops", colors: ["Navy"], price: 420 }), "https://second.example/ghost", c.id);
  }
  {
    const navy = card("Arc'teryx", "Beta LT Jacket", { colors: ["Navy"], price: 450 });
    const sky = card("Arc'teryx", "Beta LT Jacket", { colors: ["Sky Blue"], price: 450 });
    await joins("two blue cards: the closer one", [navy, sky], page("Arc'teryx", "Beta LT Jacket", { colors: ["Navy Blue"], price: 460 }), "https://second.example/beta", navy.id);
  }
  {
    const black = card("Arc'teryx", "Atom Hoody", { colors: ["Black"], price: 300 });
    const green = card("Arc'teryx", "Atom Hoody", { colors: ["Green"], price: 300 });
    await joins("the page names no colour: the model's first card", [black, green], page("Arc'teryx", "Atom Hoody", { colors: [], price: 310 }), "https://second.example/atom", black.id);
  }
  {
    const c = card("Nike", "Tech Fleece Windrunner Hoodie 2026", { category: "tops", colors: ["Black"], price: 130 });
    db.reset([c]);
    const r = await importParsedProduct(page("Nike", "Tech Fleece Windrunner Hoodie 2026", { category: "tops", colors: ["Pink"], price: 130 }), "https://second.example/tf-pink", {});
    ok("another colour still makes its own card", db.inserts().length === 1);
    ok("and the run says why it made one", typeof r.linkNote === "string" && /new card/.test(r.linkNote) && /Black/.test(r.linkNote), String(r.linkNote));
  }

  console.log("— and what must stay two cards —");
  {
    const c = card("Jordan", "Jordan 4 Retro", { category: "footwear", colors: ["Red"], price: 210 });
    await staysApart("Jordan 4 Retro vs Jordan 4 Retro Toro Bravo", [c], page("Jordan", "Jordan 4 Retro Toro Bravo", { category: "footwear", colors: ["Red"] }), "https://second.example/j4-toro");
  }
  {
    const c = card("Carhartt WIP", "Detroit Jacket");
    await staysApart("Detroit Jacket vs Michigan Coat", [c], page("Carhartt", "Michigan Coat"), "https://second.example/michigan");
  }
  {
    const c = card("Palm Angels", "Track Jacket Classic Logo 2026");
    await staysApart("Palm Angels is not Angels", [c], page("Angels", "Track Jacket Classic Logo 2026"), "https://second.example/angels");
  }
  {
    const c = card("adidas", "Samba OG Shoes", { category: "footwear", colors: ["White"], price: 100 });
    await staysApart("another colourway stays apart", [c], page("adidas", "Samba OG Shoes", { category: "footwear", colors: ["Green"], price: 100 }), "https://second.example/samba-green");
  }

  console.log("— the Duplicates screen finds the pairs already made —");
  {
    const { findDuplicateGroups } = require(path.join(COMPILED, "lib", "server", "duplicates.js"));
    const row = (id, brand, name, host, extra = {}) => ({
      id, brand, name,
      category: extra.category ?? "outerwear",
      sourceUrl: `https://${host}/p/${id}`,
      priceMin: extra.price ?? 200,
      retailers: [{ name: host, url: `https://${host}/p/${id}`, price: extra.price ?? 200, currency: "USD" }],
      colors: extra.colors ?? ["Black"],
      images: [],
      createdAt: null,
    });
    const rows = [
      row("a1", "adidas", "Samba OG Shoes", "adidas.com", { category: "footwear", colors: ["White"], price: 100 }),
      row("a2", "adidas Originals", "adidas Originals Samba OG", "reseller.example", { category: "footwear", colors: ["White"], price: 110 }),
      row("j1", "Jordan", "Jordan 4 Retro Toro Bravo", "nike.com", { category: "footwear", colors: ["Red"], price: 210 }),
      row("j2", "Jordan", "Air Jordan 4 Retro 'Toro Bravo' (2026)", "stockx.com", { category: "footwear", colors: ["Red"], price: 240 }),
      row("j3", "Jordan", "Jordan 4 Retro", "stockx.com", { category: "footwear", colors: ["Red"], price: 210 }),
      row("p1", "Palm Angels", "Track Jacket Classic Logo 2026", "palmangels.com"),
      row("p2", "Angels", "Track Jacket Classic Logo 2026", "reseller.example"),
    ];
    const groups = findDuplicateGroups(rows).map((g) => [...g.ids].sort().join("+"));
    ok("adidas / adidas Originals found as one item", groups.includes("a1+a2"), JSON.stringify(groups));
    ok("Toro Bravo / Toro Bravo (2026) found as one item", groups.includes("j1+j2"), JSON.stringify(groups));
    ok("Jordan 4 Retro is not in either", !groups.some((g) => g.includes("j3")), JSON.stringify(groups));
    ok("Palm Angels and Angels are not one", !groups.some((g) => g.includes("p1")), JSON.stringify(groups));
  }

  console.log("");
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`  ${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
