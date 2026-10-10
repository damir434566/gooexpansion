/**
 * A stand-in for `@/lib/supabase` for the importer tests.
 *
 * Answers `products` reads from an in-memory list (eq, ilike, in, and the
 * jsonb `cs` filter on retailers), `brands` reads from the Brands list a test
 * sets, and every other table with nothing, and records inserts, updates and
 * upserts instead of performing them — the importer's writes are the result.
 *
 * Two opt-ins for the SSENSE tests: `storage`, a bucket that takes uploads, and
 * `lateRows`, rows a parallel import commits between this import's lookup and
 * its insert — invisible to the lookup, there for the insert to collide with.
 */
let rows = [];
let writes = [];
let brands = [];
let lateRows = [];
let storage = false;
let uploads = [];
const STORAGE_ORIGIN = "https://own.supabase.co";

function builder(table) {
  const q = { table, filters: [], op: "select", row: null, single: false, limit: 0 };
  const run = () => {
    if (q.op === "insert" && table === "products") {
      const late = lateRows.findIndex((r) => r.source_url && r.source_url === q.row?.source_url);
      if (late >= 0) {
        // `invisible`: the collision is on some other unique column, and
        // nothing ever appears at this address.
        const [row] = lateRows.splice(late, 1);
        if (!row.invisible) rows.push(row);
        return {
          data: null,
          error: { code: "23505", message: 'duplicate key value violates unique constraint "products_source_url_idx"' },
        };
      }
    }
    if (q.op === "insert" || q.op === "update" || q.op === "upsert") {
      writes.push({ table, op: q.op, row: q.row, filters: q.filters });
      return { data: q.single ? { id: q.op === "insert" ? "new-id" : q.filters.find((f) => f[1] === "id")?.[2] } : [], error: null };
    }
    if (table === "brands") return { data: brands.map((name) => ({ name })), error: null };
    if (table !== "products") return { data: q.single ? null : [], error: null };
    let out = rows.filter((r) =>
      q.filters.every(([kind, col, val]) => {
        if (kind === "eq") return r[col] === val;
        if (kind === "ilike") {
          // PostgREST ilike: % is any run, \% and \_ are literal.
          const pattern = String(val)
            .split(/(\\[%_]|%)/)
            .map((part) => (part === "%" ? ".*" : part.replace(/^\\/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
            .join("");
          return new RegExp(`^${pattern}$`, "is").test(String(r[col] ?? ""));
        }
        if (kind === "in") return val.includes(r[col]);
        if (kind === "cs") {
          // jsonb containment of an array of objects: each wanted object is
          // a subset of some element of the row's array.
          const have = Array.isArray(r[col]) ? r[col] : [];
          return JSON.parse(val).every((want) => have.some((h) => h && Object.entries(want).every(([k, v]) => h[k] === v)));
        }
        return true;
      }),
    );
    if (q.limit) out = out.slice(0, q.limit);
    return { data: q.single ? out[0] ?? null : out, error: null };
  };
  const b = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(run()).then(res, rej);
        return (...args) => {
          if (prop === "insert") { q.op = "insert"; q.row = args[0]; }
          else if (prop === "upsert") { q.op = "upsert"; q.row = args[0]; }
          else if (prop === "update") { q.op = "update"; q.row = args[0]; }
          else if (prop === "eq") q.filters.push(["eq", args[0], args[1]]);
          else if (prop === "ilike") q.filters.push(["ilike", args[0], args[1]]);
          else if (prop === "in") q.filters.push(["in", args[0], args[1]]);
          else if (prop === "filter") q.filters.push([args[1], args[0], args[2]]);
          else if (prop === "maybeSingle" || prop === "single") q.single = true;
          else if (prop === "limit") q.limit = args[0];
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
  storage: {
    createBucket: async () => ({ error: storage ? { message: "The resource already exists" } : { message: "no storage" } }),
    from: () => ({
      upload: async (path) => {
        if (!storage) return { error: { message: "no storage" } };
        uploads.push(path);
        return { error: null };
      },
      getPublicUrl: (path) => ({
        data: { publicUrl: storage ? `${STORAGE_ORIGIN}/storage/v1/object/public/product-images/${path}` : "" },
      }),
    }),
  },
};

module.exports = {
  supabase,
  isSupabaseConfigured: true,
  dbToColorGroup: (r) => r,
  STORAGE_ORIGIN,
  reset(list, opts = {}) {
    rows = list.map((r) => ({ ...r }));
    writes = [];
    if (opts.brands) brands = [...opts.brands];
    lateRows = (opts.lateRows ?? []).map((r) => ({ ...r }));
    storage = !!opts.storage;
    uploads = [];
  },
  /** Paths put in the bucket since the last reset. */
  uploads: () => [...uploads],
  /** Brands the importer put on the Brands list. */
  brandsAdded: () => writes.filter((w) => w.table === "brands" && w.op === "upsert").map((w) => w.row.name),
  inserts: () => writes.filter((w) => w.table === "products" && w.op === "insert"),
  updates: () => writes.filter((w) => w.table === "products" && w.op === "update"),
};
