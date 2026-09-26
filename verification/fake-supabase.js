/**
 * A stand-in for `@/lib/supabase` for the importer tests.
 *
 * Answers `products` reads from an in-memory list (eq, ilike on brand, in on
 * source_url) and every other table with nothing, and records inserts and
 * updates instead of performing them — the importer's writes are the result.
 */
let rows = [];
let writes = [];

function builder(table) {
  const q = { table, filters: [], op: "select", row: null, single: false };
  const run = () => {
    if (q.op === "insert" || q.op === "update") {
      writes.push({ table, op: q.op, row: q.row, filters: q.filters });
      return { data: q.single ? { id: q.op === "insert" ? "new-id" : q.filters.find((f) => f[1] === "id")?.[2] } : [], error: null };
    }
    if (table !== "products") return { data: q.single ? null : [], error: null };
    let out = rows.filter((r) =>
      q.filters.every(([kind, col, val]) => {
        if (kind === "eq") return r[col] === val;
        if (kind === "ilike") return String(r[col] ?? "").toLowerCase() === String(val).replace(/\\/g, "").toLowerCase();
        if (kind === "in") return val.includes(r[col]);
        return true;
      }),
    );
    return { data: q.single ? out[0] ?? null : out, error: null };
  };
  const b = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(run()).then(res, rej);
        return (...args) => {
          if (prop === "insert") { q.op = "insert"; q.row = args[0]; }
          else if (prop === "update") { q.op = "update"; q.row = args[0]; }
          else if (prop === "eq") q.filters.push(["eq", args[0], args[1]]);
          else if (prop === "ilike") q.filters.push(["ilike", args[0], args[1]]);
          else if (prop === "in") q.filters.push(["in", args[0], args[1]]);
          else if (prop === "maybeSingle" || prop === "single") q.single = true;
          return b;
        };
      },
    },
  );
  return b;
}

const supabase = {
  from: (table) => builder(table),
  rpc: async () => ({ data: null, error: null }),
  storage: { from: () => ({ upload: async () => ({ error: { message: "no storage" } }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
};

module.exports = {
  supabase,
  isSupabaseConfigured: true,
  dbToColorGroup: (r) => r,
  reset(list) { rows = list.map((r) => ({ ...r })); writes = []; },
  inserts: () => writes.filter((w) => w.table === "products" && w.op === "insert"),
  updates: () => writes.filter((w) => w.table === "products" && w.op === "update"),
};
