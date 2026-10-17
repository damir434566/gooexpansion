/**
 * Each piece the extension imports is checked at once: `catalogue-check/store.ts`.
 *
 * Decision 3b of plan 001: a piece collected by the extension should arrive
 * finished. After every ingest the collect route hands the piece to
 * `checkCollectedProducts`; the background sweep checks it ahead of
 * everything else and writes the sure fixes — the style among them — even
 * when the AI check is set to "Suggest only". The unsure ones wait on the AI
 * check page like any other; the spend goes in the day's `extension` run,
 * under the same monthly cap. Past the cap, or with the check off, nothing is
 * asked and the piece is left for the background sweep.
 *
 * Runs the shipping module against an in-memory stand-in for the database and
 * the OpenAI client.
 */
const path = require("path");
const Module = require("module");

const COMPILED = path.join(__dirname, "compiled");

// ── A stand-in for @/lib/supabase ───────────────────────────────────────────
const tables = { settings: [], products: [], brands: [], catalogue_check_fixes: [], catalogue_check_runs: [] };
let nextFixId = 1;
function query(table) {
  const filters = [];
  let op = "select";
  let payload = null;
  let returning = false;
  let limit = Infinity;
  let range = null;
  const rowsOf = () =>
    (tables[table] || []).filter((r) =>
      filters.every(([k, c, v]) =>
        k === "eq" ? r[c] === v : k === "gte" ? r[c] >= v : k === "in" ? v.includes(r[c]) : k === "is" ? (r[c] ?? null) === v : true,
      ),
    );
  const q = {
    select() {
      if (op !== "select") returning = true;
      return q;
    },
    eq(c, v) {
      filters.push(["eq", c, v]);
      return q;
    },
    gte(c, v) {
      filters.push(["gte", c, v]);
      return q;
    },
    in(c, v) {
      filters.push(["in", c, v]);
      return q;
    },
    is(c, v) {
      filters.push(["is", c, v]);
      return q;
    },
    order() {
      return q;
    },
    limit(n) {
      limit = n;
      return q;
    },
    range(from, to) {
      range = [from, to];
      return q;
    },
    insert(rows) {
      op = "insert";
      payload = rows;
      return q;
    },
    update(row) {
      op = "update";
      payload = row;
      return q;
    },
    delete() {
      op = "delete";
      return q;
    },
    async maybeSingle() {
      const row = rowsOf()[0];
      return { data: row ? JSON.parse(JSON.stringify(row)) : null, error: null };
    },
    then(resolve, reject) {
      let data = null;
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) =>
          table === "catalogue_check_fixes" ? { id: nextFixId++, ...r } : { ...r },
        );
        tables[table].push(...list);
        data = returning ? list.map((r) => ({ id: r.id })) : null;
      } else if (op === "update") {
        for (const r of rowsOf()) Object.assign(r, JSON.parse(JSON.stringify(payload)));
      } else if (op === "delete") {
        const gone = new Set(rowsOf());
        tables[table] = tables[table].filter((r) => !gone.has(r));
      } else {
        let rows = rowsOf();
        if (range) rows = rows.slice(range[0], range[1] + 1);
        data = rows.slice(0, limit).map((r) => JSON.parse(JSON.stringify(r)));
      }
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return q;
}

// ── A stand-in for the openai package: answers per product id ───────────────
const calls = [];
let answers = {};
class FakeOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: async (body) => {
          const products = body.messages[1].content
            .split("\n")
            .slice(1)
            .map((l) => JSON.parse(l));
          calls.push({ ids: products.map((p) => p.id), products });
          return {
            choices: [{ message: { content: JSON.stringify({ products: products.map((p) => ({ id: p.id, fixes: answers[p.id] ?? [] })) }) } }],
            usage: { prompt_tokens: 2000, completion_tokens: 120 },
          };
        },
      },
    };
  }
}

const STUBS = {
  "@/lib/supabase": { supabase: { from: query }, isSupabaseConfigured: true },
  "@/lib/server/get-openai-key": { getOpenAIKey: async () => "sk-test" },
  "@/lib/server/category-tree": {
    loadCategoryTree: async () => ({
      groups: [
        { label: "Shoes", items: [{ label: "Sneakers", value: "shoes" }] },
        { label: "Outerwear", items: [{ label: "Coats", value: "outerwear" }] },
      ],
      source: "database",
    }),
  },
  "@/lib/data/db": { getAllColorGroups: async () => [{ id: 1, name: "White" }, { id: 2, name: "Beige" }] },
  openai: { __esModule: true, default: FakeOpenAI },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (STUBS[request]) return `stub:${request}`;
  if (request.startsWith("@/")) request = path.join(COMPILED, request.slice(2));
  return origResolve.call(this, request, ...rest);
};
for (const [name, exports] of Object.entries(STUBS)) {
  require.cache[`stub:${name}`] = { id: `stub:${name}`, filename: `stub:${name}`, loaded: true, exports };
}

// The sweep paces itself by the clock; the test moves the clock instead of waiting.
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const later = (ms) => (clock += ms);

const store = require(path.join(COMPILED, "lib", "server", "catalogue-check", "store.js"));

let pass = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else failures.push(`${name}\n     got  ${JSON.stringify(got).slice(0, 500)}\n     want ${JSON.stringify(want).slice(0, 500)}`);
}

const today = new Date().toISOString().slice(0, 10);
const setSettings = (s) => {
  tables.settings = [{ key: "catalogue_check", value: JSON.stringify({ model: "gpt-4o-mini", notes: "", ...s }) }];
};
const piece = (id, over) => ({
  id,
  name: "Pegasus 41",
  brand: "Nike",
  category: "shoes",
  subcategory: "Sneakers",
  gender: "men",
  colors: ["White"],
  color_group_ids: [1],
  material: "",
  sizes: ["42", "43"],
  description: "A road running shoe for daily training. Engineered mesh upper, foam midsole.",
  retailers: [],
  source_url: `https://store.example/p/${id}`,
  style_keywords: [],
  catalogue_fingerprint: null,
  created_at: "2026-10-17T10:00:00.000Z",
  ...over,
});
const fix = (field, value, confidence) => ({ field, value, confidence, reason: "the record says so" });
const product = (id) => tables.products.find((p) => p.id === id);
const journal = (id) => tables.catalogue_check_fixes.filter((f) => f.product_id === id).map((f) => [f.field, f.status]);

(async () => {
  setSettings({ mode: "suggest", monthlyBudgetUsd: 5 });

  // ── "Suggest only": the extension's pieces get their sure fixes written ──
  tables.products.push(
    piece("p1"),
    piece("p2", { name: "Wool overcoat", category: "outerwear", subcategory: "Coats", colors: ["Beige"], color_group_ids: [2], description: "A tailored wool coat." }),
  );
  answers = {
    p1: [fix("style", ["sporty"], "high"), fix("material", ["mesh"], "high"), fix("gender", ["women"], "medium")],
    p2: [fix("style", ["classic"], "low")],
  };
  await store.checkCollectedProducts(["p1", "p2", null]);
  check("both pieces go to the model, in one call", calls.map((c) => c.ids), [["p1", "p2"]]);
  check("the model reads each piece's style", calls[0].products.map((p) => p.style), [[], []]);
  check("a sure style is written, though the check only suggests", product("p1").style_keywords, ["sporty"]);
  check("so is the other sure fix", product("p1").material, "mesh");
  check("an unsure fix is not written", product("p1").gender, "men");
  check("it waits on the AI check page", journal("p1"), [["material", "applied"], ["style", "applied"], ["gender", "suggested"]]);
  check("a guess leaves the piece as it was", [product("p2").style_keywords, journal("p2")], [[], []]);
  check("both are stamped as checked", [!!product("p1").catalogue_fingerprint, !!product("p2").catalogue_fingerprint], [true, true]);
  const run = tables.catalogue_check_runs.find((r) => r.id === `extension-${today}`);
  check(
    "the day's extension run counts what was done",
    run && [run.trigger, run.products, run.applied, run.suggested, run.failed, run.input_tokens, run.output_tokens],
    ["extension", 2, 2, 1, 0, 2000, 120],
  );
  const spent = await store.capSpent();
  check("and spends from the monthly cap", [spent.spent > 0, Number(spent.spent.toFixed(6)) === Number(run.cost_usd.toFixed(6))], [true, true]);

  // ── The same piece imported again, unchanged: nothing is asked ───────────
  later(20_000);
  await store.checkCollectedProducts(["p1"]);
  check("an unchanged piece is not asked about again", calls.length, 1);

  // ── An import from anywhere else keeps the page's mode ───────────────────
  later(20_000);
  tables.products.push(piece("p3", { name: "Club trench coat", category: "outerwear", subcategory: "Coats", colors: ["Beige"], color_group_ids: [2], description: "A double breasted trench." }));
  answers.p3 = [fix("style", ["classic"], "high")];
  await store.checkPendingProducts({ ids: ["p3"] });
  check("a CSV or Parse URL import in Suggest only: the sure style waits for a person", [product("p3").style_keywords, journal("p3")], [[], [["style", "suggested"]]]);
  check("and is the background sweep's run, not the extension's", tables.catalogue_check_runs.find((r) => r.id === `auto-${today}`)?.products, 1);

  // ── Past the cap: nothing is asked, the piece is left for the sweep ──────
  later(20_000);
  run.cost_usd = 5;
  tables.products.push(piece("p4"));
  answers.p4 = [fix("style", ["sporty"], "high")];
  const before = calls.length;
  await store.checkCollectedProducts(["p4"]);
  check("past the cap the model is not called", calls.length, before);
  check("the piece stays unchecked", [product("p4").catalogue_fingerprint, product("p4").style_keywords], [null, []]);

  // The cap raised: the background sweep comes to it in its own time.
  later(61 * 60_000);
  setSettings({ mode: "suggest", monthlyBudgetUsd: 100 });
  await store.checkPendingProducts();
  check("once the cap allows, the sweep checks it", [calls.length, !!product("p4").catalogue_fingerprint], [before + 1, true]);
  check("under the page's own mode", journal("p4"), [["style", "suggested"]]);

  // ── The check off: nothing runs by itself, the extension's pieces neither ──
  later(20_000);
  setSettings({ mode: "off", monthlyBudgetUsd: 100 });
  tables.products.push(piece("p5"));
  const offBefore = calls.length;
  await store.checkCollectedProducts(["p5"]);
  check("with the check off the model is not called", [calls.length, product("p5").catalogue_fingerprint], [offBefore, null]);

  // ── Auto-fix: the same as ever ───────────────────────────────────────────
  later(20_000);
  setSettings({ mode: "auto", monthlyBudgetUsd: 100 });
  tables.products.push(piece("p6"));
  answers.p6 = [fix("style", ["sporty"], "high"), fix("gender", ["women"], "medium")];
  answers.p5 = [];
  await store.checkCollectedProducts(["p6"]);
  check("in Auto-fix the extension's sure fixes are written as well", [product("p6").style_keywords, journal("p6")], [["sporty"], [["style", "applied"], ["gender", "suggested"]]]);

  Date.now = realNow;
  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
})();
