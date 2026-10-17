/**
 * The extension's AI choices spend from the AI check's monthly cap.
 *
 * Decision 6a of plan 001: one cap for everything. `catalogue-check/store.ts`
 * records what the whole-store run's asking cost (which categories, which
 * pieces) in a `collect` run, one row a day, and counts it with the
 * background sweep against `monthlyBudgetUsd`. The collect route asks
 * `capSpent()` before every choice and goes without AI past the cap.
 *
 * Runs the shipping module against an in-memory stand-in for the two tables
 * it touches: `settings` (the cap) and `catalogue_check_runs` (the spend).
 */
const path = require("path");
const Module = require("module");

const COMPILED = path.join(__dirname, "compiled");

// ── A stand-in for @/lib/supabase: settings and catalogue_check_runs ─────────
const tables = { settings: [], catalogue_check_runs: [] };
function query(table) {
  const filters = [];
  let op = "select";
  let payload = null;
  const rowsOf = () =>
    (tables[table] || []).filter((r) => filters.every(([k, c, v]) => (k === "eq" ? r[c] === v : k === "gte" ? r[c] >= v : true)));
  const q = {
    select() {
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
    insert(row) {
      op = "insert";
      payload = row;
      return q;
    },
    update(row) {
      op = "update";
      payload = row;
      return q;
    },
    async maybeSingle() {
      return { data: rowsOf()[0] ?? null, error: null };
    },
    then(resolve, reject) {
      try {
        if (op === "insert") {
          (tables[table] = tables[table] || []).push({ ...payload });
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        if (op === "update") {
          for (const r of rowsOf()) Object.assign(r, payload);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: rowsOf(), error: null }).then(resolve, reject);
      } catch (err) {
        return Promise.reject(err).then(resolve, reject);
      }
    },
  };
  return q;
}
const FAKE_SUPABASE = { supabase: { from: query }, isSupabaseConfigured: true };

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/supabase") return "fake-supabase-runs";
  if (request.startsWith("@/")) request = path.join(COMPILED, request.slice(2));
  return origResolve.call(this, request, ...rest);
};
require.cache["fake-supabase-runs"] = { id: "fake-supabase-runs", filename: "fake-supabase-runs", loaded: true, exports: FAKE_SUPABASE };

const store = require(path.join(COMPILED, "lib", "server", "catalogue-check", "store.js"));

let pass = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else failures.push(`${name}\n     got  ${JSON.stringify(got).slice(0, 500)}\n     want ${JSON.stringify(want).slice(0, 500)}`);
}

const today = new Date().toISOString().slice(0, 10);
const thisMonth = new Date().toISOString().slice(0, 7);
const usage = (costUsd, input = 1000, output = 100) => ({ input, cached: 0, output, costUsd });

(async () => {
  tables.settings.push({ key: "catalogue_check", value: JSON.stringify({ mode: "suggest", model: "gpt-4o-mini", monthlyBudgetUsd: 5, notes: "" }) });
  // Spent before today: the background sweep, a run from the page, a brand review.
  tables.catalogue_check_runs.push(
    { id: `auto-${today}`, trigger: "auto", cost_usd: 1.25, started_at: `${thisMonth}-01T08:00:00.000Z` },
    { id: "manual-x", trigger: "manual", cost_usd: 3.0, started_at: `${thisMonth}-01T09:00:00.000Z` },
    { id: "brands-x", trigger: "brands", cost_usd: 0.5, started_at: `${thisMonth}-01T10:00:00.000Z` },
    { id: "auto-old", trigger: "auto", cost_usd: 9.0, started_at: "2020-01-01T00:00:00.000Z" },
  );

  check("before any collecting: the sweep's spend, not runs from the page, not last year's", await store.capSpent(), { spent: 1.25, cap: 5 });

  await store.recordCollectSpend("gpt-4o-mini", 112, usage(0.0021, 9000, 400));
  await store.recordCollectSpend("gpt-4o-mini", 48, usage(0.0009, 4000, 150));
  const rows = tables.catalogue_check_runs.filter((r) => r.trigger === "collect");
  check("one collect run a day, however many choices", rows.map((r) => r.id), [`collect-${today}`]);
  check(
    "it adds up what was judged and what it cost",
    [rows[0].products, rows[0].input_tokens, rows[0].output_tokens, Number(rows[0].cost_usd.toFixed(4)), rows[0].model],
    [160, 13000, 550, 0.003, "gpt-4o-mini"],
  );
  check("and writes no fixes", [rows[0].applied, rows[0].suggested, rows[0].failed], [0, 0, 0]);
  const after = await store.capSpent();
  check("the extension's spend counts against the same cap", Number(after.spent.toFixed(4)), 1.253);

  // Past the cap.
  rows[0].cost_usd = 3.9;
  const full = await store.capSpent();
  check("past the cap: spent >= cap, the route then asks nothing", [Number(full.spent.toFixed(2)), full.cap, full.spent >= full.cap], [5.15, 5, true]);

  // A cap of 0 stops it all.
  tables.settings[0].value = JSON.stringify({ mode: "suggest", model: "gpt-4o-mini", monthlyBudgetUsd: 0, notes: "" });
  const zero = await store.capSpent();
  check("a cap of 0: nothing is asked", zero.spent >= zero.cap, true);

  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
})();
