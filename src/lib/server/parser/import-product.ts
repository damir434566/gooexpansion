/**
 * Persist a parsed product into the catalog.
 *
 * Shared by the single-product import route, the bulk crawler, the collect
 * extension and the CSV feed import. Deduping is by `source_url`: re-importing
 * the same page updates the existing row instead of creating a twin, which is
 * what makes a crawl safe to re-run.
 *
 * Photos are mirrored into our own storage first (see
 * `@/lib/server/storage/product-images`) so the catalog never depends on a
 * retailer CDN staying friendly.
 */
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { productToDb, writeProductRow } from "@/lib/data/db";
import {
  colorToHex,
  colorGroupNamesFor,
  looksLikeColourLabel,
  MAX_PRODUCT_IMAGES,
} from "@/lib/server/product-fields";
import { toUsd } from "@/lib/server/fx";
import { normalizeStyleKeywords } from "@/lib/style-keywords";
import { isColorSiblingByName, sameModelFamily, type VariantCandidate } from "./variant-group";
import { joinColourGroup } from "@/lib/server/colour-group";
import {
  gtinSpellings,
  isSameItem,
  isSameRetailer,
  mergePatch,
  pickSameItemByName,
  withRetailer,
  type ExistingItem,
  type IncomingItem,
  type NamedItem,
} from "./same-item";
import { brandSearchWord, brandVocabulary, decideBrand, foldBrand, isShopName } from "./brand-from-name";
import { articleCodePatterns, articleCodes, modelWord, pieceName } from "./piece-name";
import { listingKey, sameListing, urlSpellings } from "./listing-url";
import { buildCatalogueIndex, type CatalogueIndex, type CataloguePiece } from "./catalogue-match";
import { loadRetailerRules, resolveRetailer, storeDefaultGender } from "@/lib/server/retailer-domains";
import { loadCatalogueProfile, proposeGender, proposeStyles } from "@/lib/server/catalogue-profile";
import { mirrorProductImages } from "@/lib/server/storage/product-images";
import { sampleGarmentColours, storeBackgroundColor } from "@/lib/server/bg-color";
import type { Product, Category, Gender } from "@/lib/types";

const CATEGORIES: Category[] = [
  "outerwear", "tops", "shirts", "bottoms", "jeans", "shorts", "skirts",
  "footwear", "accessories", "bags", "dresses", "jumpsuits", "knitwear",
  "blazers", "swimwear",
];
const GENDERS: Gender[] = ["women", "men", "unisex"];

function httpUrl(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return /^https?:\/\//.test(s) ? s : "";
}

// ── Colour filters ────────────────────────────────────────────────────────────
// A product the parser brought in with "Core Black" on it should appear under
// Black in the browse filter without anyone opening the editor. That means
// turning the store's word into `color_group_ids`, which are database ids — so
// the groups have to be read, not guessed. They change about never, and a crawl
// batch imports five products per request, so one read is cached for the run.

const COLOR_GROUP_TTL_MS = 5 * 60_000;
let colorGroupCache: { at: number; byName: Map<string, number> } | null = null;

async function loadColorGroups(): Promise<Map<string, number> | null> {
  if (colorGroupCache && Date.now() - colorGroupCache.at < COLOR_GROUP_TTL_MS) {
    return colorGroupCache.byName;
  }
  const { data, error } = await supabase!.from("color_groups").select("id, name");
  // No table (migration not run) is not an error worth failing an import over —
  // the product lands without a colour filter, exactly as it did before.
  if (error || !data) return null;
  const byName = new Map<string, number>();
  for (const g of data as { id: number; name: string }[]) {
    byName.set(String(g.name).trim().toLowerCase(), g.id);
  }
  colorGroupCache = { at: Date.now(), byName };
  return byName;
}

/** The colour-filter ids for these filter names ("Black", "Multicolor"). */
async function colorGroupIdsFor(names: string[]): Promise<number[] | undefined> {
  if (!names.length) return undefined;
  const byName = await loadColorGroups();
  if (!byName) return undefined;
  const ids = names
    .map((n) => byName.get(n.toLowerCase()))
    .filter((id): id is number => typeof id === "number");
  return ids.length ? [...new Set(ids)] : undefined;
}

// ── Brands ────────────────────────────────────────────────────────────────────
// The brands a product name is checked against: the admin's Brands list first
// (its spelling wins), then every brand the catalogue already carries, so a
// brand one store stated properly is recognised in the next store's titles.
// Cached like the colour groups — a collect run imports a page every couple of
// seconds, and the list changes when an admin adds a brand, not per product.

const BRAND_TTL_MS = 5 * 60_000;
/** `curated` is the Brands list alone; `brands` adds what the catalogue carries. */
let brandCache: { at: number; brands: string[]; curated: string[] } | null = null;

async function loadKnownBrands(): Promise<string[]> {
  if (brandCache && Date.now() - brandCache.at < BRAND_TTL_MS) return brandCache.brands;
  const curated: string[] = [];
  const catalogue: string[] = [];
  try {
    const [table, rows] = await Promise.all([
      supabase!.from("brands").select("name"),
      supabase!.from("products").select("brand").neq("brand", "").limit(5000),
    ]);
    // Either read can fail on its own (no brands table on an older database);
    // the other still gives a usable list.
    for (const r of (table.data ?? []) as { name: string | null }[]) if (r.name) curated.push(r.name);
    for (const r of (rows.data ?? []) as { brand: string | null }[]) if (r.brand) catalogue.push(r.brand);
  } catch {
    /* no connection — no list, and the page's own brand stands as it was */
  }
  const brands = brandVocabulary(curated, catalogue);
  brandCache = { at: Date.now(), brands, curated };
  return brands;
}

/**
 * Put a brand on the Brands list if it is not there yet, so a maker first met
 * in a collect run shows in the brand filter and the Brand Manager without an
 * admin typing it in. Not the store's own name: a shop that fills the brand
 * with itself does not become a brand. Returns whether it was added; a list
 * that cannot be written (no table, no rights) leaves the product as it is.
 */
async function ensureBrandListed(brand: string, host: string): Promise<boolean> {
  const name = brand.replace(/\s+/g, " ").trim();
  if (!name || name.length > 60 || !/\p{L}/u.test(name) || isShopName(name, host)) return false;
  // Within the vocabulary's rules: no one-letter "brands", no "Unknown".
  if (!brandVocabulary([name]).length) return false;
  await loadKnownBrands();
  const curated = brandCache?.curated ?? [];
  if (curated.some((b) => foldBrand(b) === foldBrand(name))) return false;
  try {
    const { error } = await supabase!
      .from("brands")
      .upsert({ name }, { onConflict: "name", ignoreDuplicates: true });
    if (error) return false;
  } catch {
    return false;
  }
  curated.push(name);
  if (brandCache && !brandCache.brands.some((b) => foldBrand(b) === foldBrand(name))) brandCache.brands.push(name);
  return true;
}

/** What the run's row says when a page's link was taken off another variant's card. */
function unlinkedNote(names: string[]): string {
  return `its link taken off ${names.map((n) => `"${n}"`).join(", ")} (another variant)`;
}

// ── The catalogue a links-only run looks for ──────────────────────────────────
// Every card's name, brand, colour, part number and pages, read once a minute
// at most: a collect run plans a round every few dozen pages, and the cards it
// looks for change when a run adds a link, not between two of its rounds.

const CATALOGUE_TTL_MS = 60_000;
const CATALOGUE_PAGE = 1_000;
const CATALOGUE_MAX = 20_000;
let catalogueCache: { at: number; index: CatalogueIndex } | null = null;

/**
 * Null when the catalogue could not be read at all — the run then opens the
 * store's pages in its own order, as before, rather than none of them.
 */
export async function loadCatalogueIndex(): Promise<CatalogueIndex | null> {
  if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) return catalogueCache.index;
  if (!isSupabaseConfigured || !supabase) return null;
  // The part number exists only with migration 020; without it, the rest.
  for (const columns of ["name, brand, colors, mpn, source_url, retailers", "name, brand, colors, source_url, retailers"]) {
    const rows: CataloguePiece[] = [];
    let failed = false;
    for (let from = 0; from < CATALOGUE_MAX; from += CATALOGUE_PAGE) {
      const { data, error } = await supabase
        .from("products")
        .select(columns)
        .order("id")
        .range(from, from + CATALOGUE_PAGE - 1);
      if (error) {
        failed = true;
        break;
      }
      const batch = (data ?? []) as unknown as {
        name: string | null;
        brand: string | null;
        colors: string[] | null;
        mpn?: string | null;
        source_url: string | null;
        retailers: { url?: string }[] | null;
      }[];
      for (const r of batch) {
        rows.push({
          name: r.name ?? "",
          brand: r.brand,
          colors: r.colors,
          mpn: r.mpn,
          urls: [r.source_url, ...(Array.isArray(r.retailers) ? r.retailers.map((x) => x?.url) : [])],
        });
      }
      if (batch.length < CATALOGUE_PAGE) break;
    }
    if (failed) continue;
    const index = buildCatalogueIndex(rows);
    catalogueCache = { at: Date.now(), index };
    return index;
  }
  return null;
}

// ── Colour variants ───────────────────────────────────────────────────────────
// One colourway per page is how a store sells; one card per piece is how the
// catalogue shows. Products arrive one at a time — a collect run imports a page,
// the CSV import a batch of feed rows — so grouping has to happen against the
// rows already in the table. Two signals, judged in `variant-group.ts`: the
// addresses the page's own colour row links to (the CSV import passes the feed
// links of the piece's other colours the same way), and brand and name — the
// only one that reaches the same piece collected from another store.

interface VariantRow {
  id: string;
  brand: string | null;
  name: string | null;
  colors: string[] | null;
  category: string | null;
  variant_group_id: string | null;
  is_group_primary: boolean | null;
}

function toCandidate(row: VariantRow): VariantCandidate {
  return {
    id: row.id,
    brand: row.brand,
    name: row.name ?? "",
    colors: row.colors ?? [],
    category: row.category,
    variantGroupId: row.variant_group_id,
    isGroupPrimary: row.is_group_primary,
  };
}

const VARIANT_COLUMNS = "id, brand, name, colors, category, variant_group_id, is_group_primary";

/**
 * Rows of one brand read for a name comparison. Generous: the comparison runs
 * in code (`piece-name.ts`), because the piece's name can sit anywhere in a
 * store's title — "Кросівки Nike Air Max 90 чорні" — and a database prefix
 * query only finds the ones that start the same way.
 */
const BRAND_ROWS = 500;

/** PostgREST pattern metacharacters, so a product named "50% Wool" cannot match everything. */
function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (c) => `\\${c}`);
}

/**
 * The reads that find a piece's cards by name, as `ilike` patterns on the
 * brand and the name columns — one list for both questions asked of a page
 * (another store's listing of it, and its other colours), so they see the same
 * cards.
 *
 * By the brand's first word, not its whole spelling: "adidas" and "adidas
 * Originals", "Carhartt" and "Carhartt WIP" are one maker, and an exact match
 * never showed a card to the other spelling. Narrowed by the model's own word
 * as well, because a brand with more cards than one read returns hid the very
 * card the page belongs to. By the model's word alone, whatever the brand
 * column says: a card saved before its brand was read has none, and a page
 * whose brand was not read has none either. And by the reduced name's words in
 * order ("Кросівки Air Max 90" finds "Nike Air Max 90").
 */
function nameLookups(brand: string, name: string, colors: string[]): { brand?: string; name?: string }[] {
  const word = brandSearchWord(brand);
  const model = modelWord(name, brand, colors);
  const tokens = pieceName(name, brand, colors).full.split(" ").filter(Boolean);
  const ordered = tokens.length >= 2 || tokens.some((t) => /\d/.test(t)) ? tokens.slice(0, 5).map(escapeLike).join("%") : "";
  return [
    ...(word && model ? [{ brand: `%${escapeLike(word)}%`, name: `%${escapeLike(model)}%` }] : []),
    ...(word ? [{ brand: `%${escapeLike(word)}%` }] : []),
    ...(model ? [{ name: `%${escapeLike(model)}%` }] : []),
    ...(ordered ? [{ name: `%${ordered}%` }] : []),
  ];
}

/**
 * Every spelling of these addresses (`urlSpellings`), in slices short enough
 * for one `.in()` filter each: a store's colour row links `/p/x` where the card
 * was saved as `www…/p/x/`, and an exact match missed it.
 */
function spellingSlices(urls: string[]): string[][] {
  const slices: string[][] = [];
  let slice: string[] = [];
  let length = 0;
  for (const spelling of new Set(urls.flatMap((u) => urlSpellings(u)))) {
    if (slice.length && (slice.length >= 40 || length + spelling.length > 4000)) {
      slices.push(slice);
      slice = [];
      length = 0;
    }
    slice.push(spelling);
    length += spelling.length;
  }
  if (slice.length) slices.push(slice);
  return slices;
}

/**
 * Put this row in a colour group with the siblings it belongs to, and answer how
 * many it found.
 *
 * Runs after the write because it needs our own row id, and returns 0 rather
 * than throwing: a database without the variant columns, or a group that cannot
 * be formed, is a missing swatch row — not a reason to fail an import that has
 * already stored the product.
 */
async function linkColorVariants(input: {
  productId: string;
  brand: string;
  name: string;
  colors: string[];
  category: string;
  variantUrls: string[];
  sourceUrl: string | null;
}): Promise<number> {
  const siblings = new Map<string, VariantCandidate>();

  try {
    if (input.variantUrls.length) {
      // The page's own colour row, checked once: a link is a colourway only
      // if it can be one. A "you may also like" grid with swatches on its
      // cards read as the colour row, and other jackets joined this one.
      const ours = { name: input.name, colors: input.colors, category: input.category };
      for (const slice of spellingSlices(input.variantUrls.slice(0, 20))) {
        const { data, error } = await supabase!.from("products").select(VARIANT_COLUMNS).in("source_url", slice);
        if (error) continue;
        for (const row of (data ?? []) as unknown as VariantRow[]) {
          if (row.id === input.productId) continue;
          const candidate = toCandidate(row);
          const brands = [input.brand, candidate.brand ?? ""].filter((b) => b.trim());
          if (sameModelFamily(brands, ours, candidate)) siblings.set(row.id, candidate);
        }
      }
    }

    // By name, on every import: the colour row only ever names this store's
    // colourways, and the same piece collected from another site — under its
    // own spelling of the brand, at its own price — is found by name alone.
    const ours = {
      brand: input.brand,
      name: input.name,
      colors: input.colors,
      category: input.category,
    };
    for (const lookup of nameLookups(input.brand, input.name, input.colors)) {
      let query = supabase!.from("products").select(VARIANT_COLUMNS);
      if (lookup.brand) query = query.ilike("brand", lookup.brand);
      if (lookup.name) query = query.ilike("name", lookup.name);
      const { data, error } = await query.limit(BRAND_ROWS);
      if (error) continue;
      for (const row of (data ?? []) as unknown as VariantRow[]) {
        if (row.id === input.productId || siblings.has(row.id)) continue;
        const candidate = toCandidate(row);
        if (isColorSiblingByName(ours, candidate)) siblings.set(row.id, candidate);
      }
    }

    // A group of one is not a group. When the page links colourways we have not
    // collected yet, nothing is written now: whichever of them is imported next
    // will find this row by its address and form the group then.
    if (!siblings.size) return 0;

    const joined = await joinColourGroup([input.productId, ...siblings.keys()], input.productId);
    return "error" in joined ? 0 : siblings.size;
  } catch {
    return 0;
  }
}

// ── The same item, sold somewhere else ────────────────────────────────────────

const MERGE_COLUMNS =
  "id, brand, gtin, mpn, sku, source_url, price_min, price_max, retailers, material, description, subcategory, sizes, colors, images";

interface MergeRow {
  id: string;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  sku: string | null;
  source_url: string | null;
  price_min: number | null;
  price_max: number | null;
  retailers: Product["retailers"] | null;
  material: string | null;
  description: string | null;
  subcategory: string | null;
  sizes: string[] | null;
  colors: string[] | null;
  images: string[] | null;
}

function toExisting(row: MergeRow): ExistingItem {
  return {
    id: row.id,
    brand: row.brand,
    gtin: row.gtin,
    mpn: row.mpn,
    sku: row.sku,
    sourceUrl: row.source_url,
    priceMin: row.price_min,
    priceMax: row.price_max,
    retailers: row.retailers ?? null,
    material: row.material,
    description: row.description,
    subcategory: row.subcategory,
    sizes: row.sizes,
    colors: row.colors,
    images: row.images,
  };
}

/**
 * The product this page is a second listing of, if we already have it.
 *
 * Asked by code only — GTIN in any of its paddings, or the maker's part number
 * however it is punctuated, within one maker (`isSameItem`). Returns null on
 * any database complaint, including the one a database without migration 020
 * makes, so a catalogue that has not run it keeps importing exactly as it did
 * before: a second row rather than a second link.
 */
async function findSameItem(incoming: IncomingItem, sourceUrl: string | null): Promise<ExistingItem | null> {
  try {
    const queries: PromiseLike<{ data: unknown; error: unknown }>[] = [];
    const gtins = gtinSpellings(incoming.gtin);
    if (gtins.length) {
      queries.push(supabase!.from("products").select(MERGE_COLUMNS).in("gtin", gtins).limit(5));
    }
    if (incoming.mpn && incoming.brand) {
      const pattern = incoming.mpn.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(escapeLike).join("%");
      if (pattern) {
        queries.push(supabase!.from("products").select(MERGE_COLUMNS).ilike("mpn", pattern).limit(50));
      }
    }
    if (!queries.length) return null;

    const ours = listingKey(sourceUrl);
    for (const query of queries) {
      const { data, error } = await query;
      if (error || !Array.isArray(data)) continue;
      for (const row of data as MergeRow[]) {
        // A row we are re-importing is an update, not a merge; that path has
        // already run by the time this is asked.
        if (ours && listingKey(row.source_url) === ours) continue;
        const existing = toExisting(row);
        if (isSameItem(incoming, existing)) return existing;
      }
    }
  } catch {
    /* no columns, no connection — fall through to an ordinary insert */
  }
  return null;
}

/**
 * Column lists for the name lookup, richest first.
 *
 * The first needs migration 020 (the product codes) and the second migration
 * 010 (subcategory). A database without them refuses the select outright, and
 * the lookup would then find nothing — so it steps down to what every
 * catalogue has rather than going quiet.
 */
const NAME_MATCH_COLUMNS = [
  `${MERGE_COLUMNS}, name, category`,
  "id, brand, name, category, source_url, price_min, price_max, retailers, material, description, subcategory, sizes, colors, images",
  "id, brand, name, category, source_url, price_min, price_max, retailers, material, description, sizes, colors, images",
];

/** Fields the merge fills only when empty — so only when they were actually read. */
const FILL_ONLY_COLUMNS = ["subcategory", "gtin", "mpn", "sku"];

/**
 * The product this page is another store's listing of, found by name — for the
 * pages that carry no code, which is most of them. The decision itself is
 * `pickSameItemByName`; this only reads the brand's rows for it.
 *
 * `unread` names the fill-only columns the select could not include. The merge
 * must not write them: on such a row a value may exist that was never read, and
 * "fill when empty" would then overwrite it.
 */
async function findSameItemByName(incoming: {
  brand: string;
  name: string;
  colors: string[];
  coloursStated: boolean;
  category: string;
  price: number;
  sourceUrl: string | null;
  /** A feed's merchant, when the caller named it — see `pickSameItemByName`. */
  store?: string | null;
  mpn?: string;
  linksOnly?: boolean;
}): Promise<{ item: NamedItem | null; unread: string[]; miss?: string; stale?: NamedItem[] }> {
  if (!incoming.sourceUrl) return { item: null, unread: [], miss: "no address to add as a store" };
  const codes = articleCodes({ name: "", mpn: incoming.mpn });
  try {
    // The piece's cards by brand and name (`nameLookups`); `brandsFit` then
    // asks the names. And by what needs no brand or long word at all: the
    // card that already carries this page as a store link; the article code,
    // in the card's part number or its name.
    const lookups = nameLookups(incoming.brand, incoming.name, incoming.colors);
    const codePatterns = [...articleCodePatterns(incoming.name), ...articleCodePatterns(incoming.mpn ?? "")].slice(0, 2);
    const linkedAs = [...new Set([incoming.sourceUrl, `https://${listingKey(incoming.sourceUrl)}`])];
    for (const [pass, columns] of NAME_MATCH_COLUMNS.entries()) {
      const products = () => supabase!.from("products").select(columns);
      // Reads a database may refuse without the catalogue being unreadable —
      // a JSON containment filter, the code columns — are asked apart, and
      // their refusal only means they found nothing.
      const optional = [
        ...linkedAs.map((url) => products().filter("retailers", "cs", JSON.stringify([{ url }])).limit(5)),
        // The code columns exist only with migration 020, the first column list.
        ...(pass === 0 ? codePatterns.map((code) => products().ilike("mpn", code).limit(50)) : []),
      ];
      const reads = [
        ...lookups.map((lookup) => {
          let query = products();
          if (lookup.brand) query = query.ilike("brand", lookup.brand);
          if (lookup.name) query = query.ilike("name", lookup.name);
          return query.limit(BRAND_ROWS);
        }),
        ...codePatterns.map((code) => products().ilike("name", `%${code}%`).limit(50)),
      ];
      const seen = new Map<string, unknown>();
      let failed = false;
      for (const read of reads) {
        const { data, error } = await read;
        if (error) {
          failed = true;
          break;
        }
        for (const row of (data ?? []) as unknown as { id: string }[]) {
          if (!seen.has(row.id)) seen.set(row.id, row);
        }
      }
      if (failed) continue;
      for (const read of optional) {
        const { data, error } = await read;
        if (error) continue;
        for (const row of (data ?? []) as unknown as { id: string }[]) {
          if (!seen.has(row.id)) seen.set(row.id, row);
        }
      }
      const rows: NamedItem[] = ([...seen.values()] as (MergeRow & {
        name: string | null;
        category: string | null;
      })[]).map((row) => ({ ...toExisting(row), name: row.name ?? "", category: row.category }));
      const match = pickSameItemByName({ ...incoming, codes }, rows);
      const read = columns.split(",").map((c) => c.trim());
      return {
        item: match.item,
        miss: match.miss,
        stale: match.stale,
        unread: FILL_ONLY_COLUMNS.filter((c) => !read.includes(c)),
      };
    }
  } catch {
    /* no connection — an ordinary insert, as before */
  }
  return { item: null, unread: [], miss: "the catalogue could not be read" };
}

/**
 * The row to write when re-collecting a page whose product other stores have
 * since joined.
 *
 * A re-import writes the whole row from this one page, retailer list and price
 * included — so collecting store A again would erase store B, which a merge
 * had added as a second place to buy. B's entry is kept, this page's own entry
 * replaced, and the price range recomputed over every store on the dollar
 * scale (each entry keeps its own currency, so each is converted first).
 *
 * `ours` is this source's own entries: one for a page, one per store for a feed
 * that sells the piece through several merchants.
 */
async function keepOtherStores(
  dbRow: Record<string, unknown>,
  existing: Product["retailers"],
  ours: Product["retailers"],
  sourceUrl: string | null,
  /** A feed's entries: told apart by the merchant's name, not the link's host. */
  byName = false,
): Promise<Record<string, unknown>> {
  if (!ours.length) return dbRow;
  // Which of our entries an existing one is. A page's store is told apart by
  // address, not by name: `nike.com` and `nike.ua` are two stores that both
  // call themselves Nike. A feed's links all share the affiliate host, so
  // there the merchant's name decides.
  const oursIndex = (r: Product["retailers"][number]) =>
    ours.findIndex((o) => isSameRetailer(r, o, { byName }));
  const others = existing.filter((r) => r && (!sourceUrl || r.url !== sourceUrl) && oursIndex(r) < 0);
  if (!others.length) return dbRow;

  // One place per store of ours, the first it held. The old CSV import wrote an
  // entry per size link, and `withRetailer` replaces only the first of them, so
  // the rest would have stayed on as copies of the same shop.
  const seen = new Set<number>();
  const kept = existing.filter((r) => {
    const i = r ? oursIndex(r) : -1;
    if (i < 0) return true;
    if (seen.has(i)) return false;
    seen.add(i);
    return true;
  });
  const row: Record<string, unknown> = {
    ...dbRow,
    retailers: ours.reduce((list, entry) => withRetailer(list, entry, { byName }), kept),
  };
  if (row.currency !== "USD") return row;

  const theirs = (
    await Promise.all(others.filter((r) => r.url).map((r) => toUsd(Number(r.price) || 0, r.currency || "USD")))
  )
    .map((c) => c?.usd ?? 0)
    .filter((n) => n > 0);
  const own = Number(dbRow.price_min) || 0;
  const all = [...(own > 0 ? [own] : []), ...theirs];
  if (!all.length) return row;
  const min = Math.min(...all);
  const max = Math.max(Number(dbRow.price_max) || 0, ...all);
  return { ...row, price_min: min, price_max: max, price_min_usd: min, price_max_usd: max };
}

export interface ImportOptions {
  /** Download photos into Supabase Storage and store our URLs instead. */
  mirrorImages?: boolean;
  /**
   * What a re-import does to the row that already has this source URL.
   *
   * "replace" (the default — the parser, the crawler, the extension) rewrites
   * it from the page, keeping only the editor's style and gender. "refresh"
   * writes just what a feed is the authority on — the price, the stores with
   * their stock, the sizes — and leaves the name, category, description, tags,
   * photos and grouping the editor curates after the first import alone. It
   * also finds the product this link once joined as a second store, and there
   * writes only this source's stores and the price range they give.
   */
  onExisting?: "replace" | "refresh";
  /**
   * The "Where to buy" entries, when the caller has resolved them itself: a
   * feed names its merchant in a column (the link is an affiliate tracker's)
   * and can sell one piece through several stores. Otherwise the one entry is
   * derived from the source URL.
   */
  retailers?: Product["retailers"];
  /**
   * The page only adds a place to buy. A piece the catalogue already has gains
   * this store's link and price and nothing else; a piece it does not have is
   * skipped rather than created. For collecting a second store's links onto
   * cards made from the first.
   */
  linksOnly?: boolean;
}

export interface ImportResult {
  ok: boolean;
  productId: string | null;
  updated: boolean;
  error?: string;
  /** How many photos ended up on our storage. */
  imagesMirrored?: number;
  /** Photos we failed to mirror (kept as original URLs). */
  imagesFailed?: number;
  /** Photos stored on the product, mirrored or not. */
  images?: number;
  /** The conversion that was applied to the price, or why none was. */
  priceNote?: string;
  /** Set when the brand was read off the product name rather than the page. */
  brandNote?: string;
  /** Set when the colour filter came from the name or the photo, not the label. */
  colorNote?: string;
  /** Set when the gender came from the store or the catalogue's history, not the page. */
  genderNote?: string;
  /** What argued for the style tags written, when any were. */
  styleNote?: string;
  /** How many colour siblings this row was grouped with, if any. */
  variantsLinked?: number;
  /** Set when this page joined an existing product instead of creating one. */
  mergedInto?: string;
  /** What recognised it: a product code, or the name and colour. */
  mergedBy?: "code" | "name";
  /** What the merge filled in on that product. */
  mergedFields?: string[];
  /** Set when nothing was written, and why: a links-only page with no card to join. */
  skipped?: string;
  /** What a links-only page did to a card, when it was not a merge. */
  linkNote?: string;
  /**
   * Columns the row went in without, because the database does not have them
   * yet (a migration not run). The product is saved; these fields are not.
   */
  droppedColumns?: string[];
}

/** The migration that adds each optional product column, for the warning below. */
const COLUMN_MIGRATION: Record<string, string> = {
  subcategory: "010_product_subcategory.sql",
  bg_color: "015_product_bg_color.sql",
  price_min_usd: "019_product_price_usd.sql",
  price_max_usd: "019_product_price_usd.sql",
  source_price: "019_product_source_price.sql",
  source_currency: "019_product_source_price.sql",
  fx_rate: "019_product_source_price.sql",
  fx_date: "019_product_source_price.sql",
  gtin: "020_product_codes.sql",
  mpn: "020_product_codes.sql",
  sku: "020_product_codes.sql",
  color_group_ids: "021_color_groups.sql",
  crop_data: "023_product_crop_data.sql",
};

/**
 * What an import says when the database is a migration behind: which columns
 * were not stored, and which migration adds them. The write itself succeeded,
 * so this is a warning to show the admin, not an error.
 */
export function droppedColumnsWarning(dropped: readonly string[]): string {
  const columns = [...new Set(dropped)];
  const files = [...new Set(columns.map((c) => COLUMN_MIGRATION[c]).filter(Boolean))];
  // color_images and the variant columns predate supabase/migrations: their
  // definitions live only in supabase-schema.sql.
  const unlisted = columns.filter((c) => !COLUMN_MIGRATION[c]);
  const many = columns.length > 1;
  const steps = [
    ...(files.length ? [`run ${files.length > 1 ? "migrations" : "migration"} ${files.join(", ")} from supabase/migrations`] : []),
    ...(unlisted.length ? [`add ${unlisted.join(", ")} as in supabase-schema.sql`] : []),
  ].join(", and ");
  const run = `${steps.charAt(0).toUpperCase()}${steps.slice(1)}.`;
  return `${many ? "Columns" : "Column"} ${columns.join(", ")} ${many ? "were" : "was"} not saved — the database is missing ${many ? "them" : "it"}. ${run}`;
}

export async function importParsedProduct(
  p: Record<string, unknown>,
  sourceUrlInput: unknown,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  if (!isSupabaseConfigured || !supabase) {
    return { ok: false, productId: null, updated: false, error: "Database not configured" };
  }

  const name = String(p.name ?? "").trim().slice(0, 300);
  if (!name) return { ok: false, productId: null, updated: false, error: "Product name is required" };

  const sourceUrl = httpUrl(sourceUrlInput ?? p.sourceUrl) || null;

  const category: Category = CATEGORIES.includes(p.category as Category)
    ? (p.category as Category)
    : "accessories";
  // What the page (or the admin, on the manual import screen) said. When it
  // said nothing, the store's setting and the catalogue's history are asked
  // further down, once the brand and the store are known.
  const statedGender: Gender | undefined = GENDERS.includes(p.gender as Gender)
    ? (p.gender as Gender)
    : undefined;

  // The tree's label for what this piece is. The parser resolves it against the
  // category tree, so whatever arrives here is a label that tree claims — but it
  // is written only when there is one, because an empty string means "cleared"
  // to `productToDb` and would erase a label an admin had set by hand.
  const subcategory = String(p.subcategory ?? "").trim().slice(0, 60);

  // Codes arrive validated from the parser (a GTIN has had its check digit
  // verified); trimmed again here because this function is also called with
  // hand-assembled records from the admin's own import screens.
  const gtin = String(p.gtin ?? "").replace(/\D/g, "").slice(0, 14);
  const mpn = String(p.mpn ?? "").trim().slice(0, 60);
  const sku = String(p.sku ?? "").trim().slice(0, 60);

  // ── Price, in one currency ──────────────────────────────────────────────────
  // The catalogue is read as dollars by everything downstream: the browse
  // filter, the stylist's budget and the search RPCs all compare `price_min`
  // against a dollar figure without ever consulting the currency column. So a
  // price arrives here in whatever the store charges and is written in dollars,
  // with the store's own number kept beside it — on the retailer entry, which
  // is what a shopper clicking through will actually be asked to pay, and in
  // the source columns, so a wrong rate can be traced instead of guessed at.
  const sourcePrice = Math.max(0, Number(p.price) || 0);
  const sourcePriceOriginal = Math.max(0, Number(p.priceOriginal) || 0);
  const sourceCurrency = String(p.currency ?? "").trim().toUpperCase().slice(0, 3);
  // Set by the parser when the page named no currency and the store's address
  // or language did — said in the note, so an inferred hryvnia is visibly one.
  const currencyBasis = String(p.currencyBasis ?? "").trim().slice(0, 80);
  const inferredNote = currencyBasis ? ` (${sourceCurrency} from ${currencyBasis})` : "";

  let price = sourcePrice;
  let priceOriginal = sourcePriceOriginal;
  let currency = sourceCurrency || "USD";
  let fxRate: number | null = null;
  let fxDate: string | null = null;
  let priceNote: string | undefined;

  if (sourcePrice && sourceCurrency && sourceCurrency !== "USD") {
    const converted = await toUsd(sourcePrice, sourceCurrency);
    if (converted) {
      price = converted.usd;
      // The same rate for both, rather than a second lookup: an original price
      // and a sale price converted at rates an hour apart would show a discount
      // the store never offered.
      priceOriginal = sourcePriceOriginal
        ? Math.round((sourcePriceOriginal / converted.rate) * 100) / 100
        : 0;
      currency = "USD";
      fxRate = converted.rate;
      fxDate = converted.asOf;
      priceNote = `${sourcePrice} ${sourceCurrency} → $${price}${converted.live ? "" : " (fallback rate)"}${inferredNote}`;
    } else {
      // A currency with no rate is left exactly as the store stated it. It will
      // read wrong in a dollar filter, and that is the lesser wrong: relabelling
      // it as dollars would make it read wrong everywhere, silently.
      priceNote = `no rate for ${sourceCurrency} — price kept as ${sourcePrice} ${sourceCurrency}${inferredNote}`;
    }
  } else if (sourcePrice && !sourceCurrency) {
    priceNote = "the page never stated a currency — price taken as dollars";
  }

  const sizes = (Array.isArray(p.sizes) ? p.sizes : [])
    .map((s: unknown) => String(s).trim())
    .filter(Boolean)
    .slice(0, 40);

  // ── A feed re-imported over its own rows ────────────────────────────────────
  // Settled before any photo is downloaded: on this path none is written, and a
  // feed re-run is mostly rows we already carry.
  if (opts.onExisting === "refresh" && sourceUrl) {
    try {
      type Found = { id: string; retailers: Product["retailers"] | null; source_url: string | null };
      const { data: found, error: findError } = await supabase
        .from("products").select("id, retailers, source_url").eq("source_url", sourceUrl).maybeSingle();
      // Unanswered is not "absent": carrying on would insert a twin of the row
      // the lookup could not see.
      if (findError) throw new Error(findError.message);
      let existing = found as Found | null;
      // A feed row that once joined another source's product has no row of its
      // own: its link is one of that product's stores. It is refreshed there —
      // otherwise every run would download its photos again only to join the
      // same product, and a store that sold out would stay "in stock".
      if (!existing) {
        const { data: joined, error: joinedError } = await supabase
          .from("products")
          .select("id, retailers, source_url")
          .contains("retailers", JSON.stringify([{ url: sourceUrl }]))
          .order("created_at", { ascending: true })
          .limit(1);
        if (joinedError) throw new Error(joinedError.message);
        existing = ((joined ?? []) as Found[])[0] ?? null;
      }
      if (existing) {
        // The product's own page is another source's: its sizes and source
        // price are that page's, and only this feed's stores are ours to write.
        const joinedOther = existing.source_url !== sourceUrl;
        let ours = opts.retailers ?? [];
        if (!ours.length) {
          const store = resolveRetailer(sourceUrl, String(p.brand ?? "").trim(), await loadRetailerRules());
          ours = [{
            name: store.name,
            url: sourceUrl,
            price: sourcePrice || price,
            currency: sourceCurrency || currency,
            availability: "in stock",
            isOfficial: store.isOfficial,
          }];
        }
        const priceMax = priceOriginal > price ? priceOriginal : price;
        // The same columns, and the same rules for them, as the full row below.
        const row: Record<string, unknown> = {
          price_min: price,
          price_max: priceMax,
          currency,
          price_min_usd: currency === "USD" ? price : null,
          price_max_usd: currency === "USD" ? priceMax : null,
          retailers: ours,
          ...(sourceCurrency && sourceCurrency !== "USD"
            ? {
                source_price: sourcePrice,
                source_currency: sourceCurrency,
                ...(fxRate !== null ? { fx_rate: fxRate } : {}),
                ...(fxDate ? { fx_date: fxDate } : {}),
              }
            : {}),
          // A piece sold out everywhere in the feed arrives with no sizes; the
          // store's entry says so, and the size list stays as it was.
          ...(sizes.length ? { sizes } : {}),
        };
        const id = existing.id;
        const current = Array.isArray(existing.retailers) ? existing.retailers : [];
        if (joinedOther) {
          for (const column of ["sizes", "source_price", "source_currency", "fx_rate", "fx_date"]) {
            delete row[column];
          }
        }
        const next = await keepOtherStores(row, current, ours, sourceUrl, !!opts.retailers);
        // A price the product cannot compare (no dollar rate), or one from a
        // store that has sold out, is not written over another source's price.
        if (joinedOther && (currency !== "USD" || ours.every((r) => r.availability === "sold out"))) {
          for (const column of ["price_min", "price_max", "currency", "price_min_usd", "price_max_usd"]) {
            delete next[column];
          }
        }
        const { data, error, dropped } = await writeProductRow<{ id: string }>(next, (r) =>
          supabase!.from("products").update(r).eq("id", id).select("id").maybeSingle(),
        );
        if (error) throw new Error(error.message);
        return {
          ok: true,
          productId: data?.id ?? id,
          updated: true,
          priceNote,
          ...(dropped.length ? { droppedColumns: dropped } : {}),
        };
      }
    } catch (err) {
      return {
        ok: false,
        productId: null,
        updated: false,
        error: err instanceof Error ? err.message : "Update failed",
      };
    }
  }

  let images = (Array.isArray(p.images) ? p.images : []).map(httpUrl).filter(Boolean).slice(0, MAX_PRODUCT_IMAGES);
  let imageUrl = httpUrl(p.imageUrl) || images[0] || "";

  // Mirror photos to our storage before writing the row, so the catalog only
  // ever references URLs we control. A failed download keeps its original URL.
  // A links-only page writes no photo anywhere, so it copies none.
  let imagesMirrored: number | undefined;
  let imagesFailed: number | undefined;
  if (opts.mirrorImages && !opts.linksOnly && (imageUrl || images.length)) {
    const mirror = await mirrorProductImages({ imageUrl, images });
    if (mirror.attempted) {
      imageUrl = mirror.imageUrl;
      images = mirror.images;
      imagesMirrored = mirror.mirrored;
      imagesFailed = mirror.failed;
    }
  }

  // Only labels that read as a colour's name. The parser already checks, but
  // this is also called with records assembled elsewhere, and a file name
  // stored here is shown to shoppers as the colour.
  let colors: string[] = (Array.isArray(p.colors) ? p.colors : [])
    .map((c: unknown) => String(c).trim())
    .filter((c: string) => looksLikeColourLabel(c))
    .slice(0, 10);
  // What the page itself said, kept apart from the photo's reading below: the
  // same-item test trusts a stated colour to rule a card out, and a reading
  // only to choose among cards.
  const coloursStated = colors.length > 0;

  // The page's brand, unless the name names a known brand the page did not —
  // the empty brand, or the shop's own name in its place, that a multi-brand
  // store leaves on every product (see `brand-from-name.ts`).
  const statedBrand = String(p.brand ?? "").trim().slice(0, 80);
  let host = "";
  try {
    host = sourceUrl ? new URL(sourceUrl).hostname : "";
  } catch {
    /* no address — nothing to tell the shop's name from a brand */
  }
  const brandDecision = decideBrand({
    stated: statedBrand,
    name,
    host,
    known: await loadKnownBrands(),
    // Printed near the product rather than declared: the name overrules it.
    weak: p.brandFromText === true,
  });
  const brand = brandDecision.brand.slice(0, 80);
  // New makers join the Brands list on their own. Not on a links-only run,
  // which creates nothing.
  const brandListed = brand && !opts.linksOnly ? await ensureBrandListed(brand, host) : false;
  const brandNote =
    [
      brandDecision.fromName
        ? `brand ${brand} from ${brandDecision.viaModel ? "the model in " : ""}the name${statedBrand ? ` (page said ${statedBrand})` : ""}`
        : "",
      brandListed ? `${brand} added to the Brands list` : "",
    ]
      .filter(Boolean)
      .join("; ") || undefined;

  // The store's name and its "official store" flag come from the domain rules
  // when the admin has written one, and from the guesses made off the link only
  // when they haven't. This is the path the bookmarklet uses, so it is where a
  // mislabelled shop would otherwise enter the catalogue one product at a time.
  const retailerRules = sourceUrl ? await loadRetailerRules() : new Map();
  const resolved = sourceUrl ? resolveRetailer(sourceUrl, brand, retailerRules) : null;

  const retailers: Product["retailers"] = opts.retailers?.length
    ? opts.retailers
    : sourceUrl && resolved
    ? [{
        name: resolved.name,
        url: sourceUrl,
        // What this store charges, in what it charges — the catalogue's price
        // is a conversion, this is the thing itself.
        price: sourcePrice || price,
        currency: sourceCurrency || currency,
        availability: "in stock",
        isOfficial: resolved.isOfficial,
      }]
    : [];

  // ── The colour filter ───────────────────────────────────────────────────────
  // From the store's colour label first. A label that names no base colour
  // ("Babymetal Storm") or no label at all used to leave the filter empty, so a
  // shopper filtering by green never saw the piece. Then the product name's own
  // colour words, then the photo — a studio shot only (see `bg-color.ts`).
  // Whatever answered is said in the collect screen, because the last two are
  // readings, not the store's word.
  let colorNote: string | undefined;
  let groupNames = colorGroupNamesFor(colors, "field");
  if (!groupNames.length) {
    groupNames = colorGroupNamesFor(name);
    if (groupNames.length) colorNote = `colour filter ${groupNames.join(", ")} from the name`;
  }
  if (!groupNames.length && imageUrl) {
    const photo = await sampleGarmentColours(imageUrl);
    if (photo.outcome === "measured" && photo.colours.length) {
      groupNames = colorGroupNamesFor(photo.colours);
      // A label only when the page gave none: the store's own word, even one
      // the filter cannot read, is still the better name to show.
      const measured = photo.colours[0].charAt(0).toUpperCase() + photo.colours[0].slice(1);
      if (!colors.length) colors = [measured];
      colorNote = `colour ${groupNames.join(", ")} from the photo (${photo.reason})`;
    }
  }
  const colorGroupIds = await colorGroupIdsFor(groupNames);

  // ── Gender and style: what the page does not say ────────────────────────────
  // A page names its gender or it doesn't; when it doesn't, the store's own
  // convention decides (the admin's setting, then the brand's and the store's
  // habit in the catalogue). Style: the description decides and the brand
  // fills in — the built-in brand list, then the brand's and the store's habit.
  // See `catalogue-profile.ts` for the order and how the two mix.
  const profile = await loadCatalogueProfile();
  let gender = statedGender;
  let genderNote: string | undefined;
  if (!gender) {
    // A feed's link is the affiliate network's (every Awin merchant is
    // awin1.com), so its host says nothing about the store: only the brand's
    // habit is asked.
    const storeUrl = opts.retailers?.length ? null : sourceUrl;
    const proposal = proposeGender(
      {
        brand,
        sourceUrl: storeUrl,
        storeDefault: storeUrl ? storeDefaultGender(storeUrl, retailerRules) : undefined,
      },
      profile,
    );
    if (proposal) {
      gender = proposal.gender;
      genderNote = `gender ${proposal.gender} from ${proposal.reason}`;
    }
  }
  const styleProposal = proposeStyles(
    { brand, keywordStyles: normalizeStyleKeywords(p.styleKeywords), sourceUrl },
    profile,
  );
  let styleNote = styleProposal.styles.length
    ? `style ${styleProposal.reasons.join("; ")}`
    : styleProposal.missing;

  const product: Partial<Product> = {
    name,
    brand: brand as Product["brand"],
    category,
    ...(subcategory ? { subcategory } : {}),
    description: String(p.description ?? "").slice(0, 5000),
    imageUrl,
    images: images.length ? images : (imageUrl ? [imageUrl] : []),
    colors,
    sizes,
    material: String(p.material ?? "").slice(0, 500),
    priceMin: price,
    priceMax: priceOriginal > price ? priceOriginal : price,
    currency,
    ...(sourceCurrency && sourceCurrency !== "USD"
      ? {
          sourcePrice,
          sourceCurrency,
          fxRate: fxRate ?? undefined,
          fxDate: fxDate ?? undefined,
        }
      : {}),
    isNew: true,
    isSaved: false,
    gender,
    // Filtered through the shared vocabulary rather than trusted: this function
    // is also called with hand-assembled records, and a tag the pickers do not
    // offer is a tag nothing can ever match.
    styleKeywords: styleProposal.styles,
    retailers,
    ...(colors[0] ? { colorHex: colorToHex(colors[0]) } : {}),
    ...(colorGroupIds ? { colorGroupIds } : {}),
    // The codes that identify the item away from this listing. Written on the
    // row so the NEXT store's page can find it.
    ...(gtin ? { gtin } : {}),
    ...(mpn ? { mpn } : {}),
    ...(sku ? { sku } : {}),
  };

  // `price_min_usd` is the column migration 019_product_price_usd gave the
  // search RPCs and the stylist's budget, which read
  // `coalesce(price_min_usd, price_min)`. Its backfill copied every old
  // price_min across unconverted, so a re-import that corrects price_min must
  // correct it too — otherwise the card says $235 and the "under $200" filter
  // still sees the 200 the store printed in euros. A price left in a currency
  // with no rate gets NULL, which reads back as price_min exactly as before.
  const dbRow = {
    ...productToDb(product),
    source_url: sourceUrl,
    price_min_usd: currency === "USD" ? product.priceMin : null,
    price_max_usd: currency === "USD" ? product.priceMax : null,
  };

  // Written through `writeProductRow` so a database that has not run the
  // colour-filter migration drops that one column and still takes the product,
  // instead of every import failing on a column it has never heard of. What was
  // dropped comes back as `droppedColumns`, for the caller to tell the admin.
  const insert = (row: Record<string, unknown>) =>
    supabase!.from("products").insert(row).select("id").maybeSingle();

  let productId: string | null = null;
  let updated = false;
  let droppedColumns: string[] = [];
  /** Why a new card was made rather than a link added, for the run's row. */
  let newCardNote: string | undefined;
  try {
    let existingId: string | null = null;
    let existingRetailers: Product["retailers"] = [];
    let existingStyled = false;
    let existingGendered = false;
    if (sourceUrl) {
      // Every spelling of this page's address: collected once as `…/am90` and
      // again as `www.…/am90/?srsltid=…`, it is still the card it made.
      const { data: existing } = await supabase
        .from("products")
        .select("id, retailers, style_keywords, gender")
        .in("source_url", urlSpellings(sourceUrl))
        .limit(1)
        .maybeSingle();
      const found = existing as {
        id: string;
        retailers: Product["retailers"] | null;
        style_keywords: string[] | null;
        gender: string | null;
      } | null;
      existingId = found?.id ?? null;
      existingRetailers = Array.isArray(found?.retailers) ? found.retailers : [];
      existingStyled = !!found?.style_keywords?.length;
      existingGendered = !!found?.gender;
    }

    if (existingId && opts.linksOnly) {
      // This page made its own card on an earlier run. A links-only run adds
      // stores and changes nothing else, so only this store's entry — its
      // price — is refreshed. Were the card a copy of another store's, the
      // Duplicates screen is where the two become one.
      const id = existingId;
      const patch: Record<string, unknown> = retailers[0]
        ? { retailers: withRetailer(existingRetailers, retailers[0], { byName: !!opts.retailers }) }
        : {};
      if (Object.keys(patch).length) {
        const { error } = await writeProductRow<{ id: string }>(patch, (r) =>
          supabase!.from("products").update(r).eq("id", id).select("id").maybeSingle(),
        );
        if (error) throw new Error(error.message);
      }
      return {
        ok: true,
        productId: id,
        updated: true,
        priceNote,
        brandNote,
        linkNote: "this page's own card from an earlier run: only its price here was refreshed",
      };
    }

    if (existingId) {
      const id = existingId;
      const row = await keepOtherStores(dbRow, existingRetailers, retailers, sourceUrl, !!opts.retailers);
      // Style and gender are the editor's to decide. Re-collecting a page used to
      // write whatever the importer guessed over them — an empty style list
      // included — so a store collected twice lost its hand-set tags. They are
      // filled only where the row has none.
      if (existingStyled) {
        delete row.style_keywords;
        styleNote = undefined;
      }
      if (existingGendered) {
        delete row.gender;
        genderNote = undefined;
      }
      // PostgREST reports failures in `error` rather than throwing, so an
      // unchecked update reads as success while writing nothing (the silent
      // failure pattern audit item Б1-3 called out on the billing ledger).
      const { data, error, dropped } = await writeProductRow<{ id: string }>(row, (r) =>
        supabase!.from("products").update(r).eq("id", id).select("id").maybeSingle(),
      );
      if (error) throw new Error(error.message);
      productId = data?.id ?? id;
      updated = true;
      droppedColumns = dropped;
    } else {
      // Before writing a new row: is this the same item, sold by someone else?
      //
      // Asked here rather than at the top of the function so the ordinary paths
      // stay untouched. The cost is that photos were mirrored a moment ago and
      // may go unused — bounded, and not always wasted, since a merge fills the
      // existing row's photos when it has none.
      const incoming: IncomingItem = {
        brand,
        gtin: product.gtin,
        mpn: product.mpn,
        sku: product.sku,
        // Dollars or nothing: a price left in a currency with no rate would
        // widen a dollar range with a hryvnia number — and so would one the
        // page never named a currency for, "4200" taken as dollars.
        price: currency === "USD" && sourceCurrency ? price : 0,
        retailer: retailers[0],
        material: product.material,
        description: product.description,
        subcategory: product.subcategory,
        sizes,
        colors,
        images: product.images,
      };
      // By code first — exact where a store prints one — then by name, brand
      // and colour, which is what most stores leave us.
      /** Cards this page's link was taken off, for the run's row. */
      const unlinked: string[] = [];
      let twin: ExistingItem | null = await findSameItem(incoming, sourceUrl);
      let mergedBy: ImportResult["mergedBy"] = twin ? "code" : undefined;
      let unread: string[] = [];
      let miss: string | undefined;
      if (!twin) {
        const byName = await findSameItemByName({
          brand,
          name,
          colors,
          coloursStated,
          category,
          price: incoming.price,
          sourceUrl,
          store: opts.retailers?.[0]?.name,
          mpn,
          linksOnly: opts.linksOnly,
        });
        miss = byName.miss;
        // A run before the name's variant was read may have put this page on
        // a card of another variant — "(Black/White)" on "(Grey/Black)". Its
        // link comes off that card; every other store there stays.
        for (const card of byName.stale ?? []) {
          const kept = (card.retailers ?? []).filter((r) => !sameListing(r.url, sourceUrl));
          const { error } = await writeProductRow<{ id: string }>({ retailers: kept }, (row) =>
            supabase!.from("products").update(row).eq("id", card.id).select("id").maybeSingle(),
          );
          if (!error) unlinked.push(card.name);
        }
        if (byName.item) {
          twin = byName.item;
          unread = byName.unread;
          mergedBy = "name";
        }
      }

      if (twin) {
        const twinId = twin.id;
        const merged = mergePatch(twin, incoming, { linksOnly: opts.linksOnly, byName: !!opts.retailers });
        const patch = merged.patch;
        // A feed selling the piece through several stores brings them all.
        if (retailers.length > 1 && Array.isArray(patch.retailers)) {
          patch.retailers = retailers
            .slice(1)
            .reduce((list, entry) => withRetailer(list, entry, { byName: true }), patch.retailers as Product["retailers"]);
        }
        for (const column of unread) delete patch[column];
        const filled = merged.filled.filter((f) => !unread.includes(f));
        // Merged prices are dollars on both sides, so the comparable scale is
        // the same number.
        if (patch.price_min !== undefined) patch.price_min_usd = patch.price_min;
        if (patch.price_max !== undefined) patch.price_max_usd = patch.price_max;
        const { error, dropped } = await writeProductRow<{ id: string }>(patch, (row) =>
          supabase!.from("products").update(row).eq("id", twinId).select("id").maybeSingle(),
        );
        if (error) throw new Error(error.message);
        // Gender and style are not in the merge — the card keeps its own — so
        // they are not reported, and neither is a colour the card did not take.
        return {
          ok: true,
          productId: twinId,
          updated: true,
          imagesMirrored,
          imagesFailed,
          images: images.length,
          priceNote,
          brandNote,
          mergedInto: twinId,
          mergedBy,
          mergedFields: filled,
          ...(dropped.length ? { droppedColumns: dropped } : {}),
          ...(unlinked.length ? { linkNote: unlinkedNote(unlinked) } : {}),
        };
      }

      if (opts.linksOnly) {
        return {
          ok: true,
          productId: null,
          updated: false,
          priceNote,
          brandNote,
          skipped: `links only: ${miss ?? "not in the catalogue"}${unlinked.length ? ` · ${unlinkedNote(unlinked)}` : ""}`,
        };
      }

      const { data, error, dropped } = await writeProductRow<{ id: string }>(dbRow, insert);
      if (error) {
        // Two imports of one page at once — the collect tab passing one
        // request twice, or a page retried while it was still saving — both
        // looked for its card, neither found one, and the second insert met
        // the unique address. The card is there: this page is in the catalogue.
        const { data: saved } = error.code === "23505" && sourceUrl
          ? await supabase.from("products").select("id").in("source_url", urlSpellings(sourceUrl)).limit(1).maybeSingle()
          : { data: null };
        const savedId = (saved as { id: string } | null)?.id;
        if (!savedId) throw new Error(error.message);
        return {
          ok: true,
          productId: savedId,
          updated: true,
          priceNote,
          brandNote,
          linkNote: "saved a moment ago by another import of this page — that card is kept",
        };
      }
      productId = data?.id ?? null;
      droppedColumns = dropped;
      if (miss) newCardNote = `new card — ${miss}`;
      if (unlinked.length) newCardNote = [newCardNote, unlinkedNote(unlinked)].filter(Boolean).join(" · ");
    }
  } catch (err) {
    return {
      ok: false,
      productId: null,
      updated: false,
      error: err instanceof Error ? err.message : "Insert failed",
    };
  }

  // Measure the backdrop the photo was shot on, so the piece lands on the
  // storefront already padded with its own colour instead of framed in white.
  //
  // This happens after the write rather than before it because by now `imageUrl`
  // points at our own storage (mirroring ran above), which is a copy we can
  // fetch without a retailer CDN rate-limiting us. Best-effort: a failure leaves
  // the column null and the batch job in the admin picks the row up.
  if (productId && imageUrl) {
    await storeBackgroundColor(productId, imageUrl);
  }

  // Group this colourway with the ones already in the table.
  let variantsLinked = 0;
  if (productId) {
    variantsLinked = await linkColorVariants({
      productId,
      brand,
      name,
      colors,
      category,
      variantUrls: (Array.isArray(p.variantUrls) ? p.variantUrls : [])
        .map((u: unknown) => httpUrl(u))
        .filter(Boolean),
      sourceUrl,
    });
  }

  return {
    ok: true,
    productId,
    updated,
    imagesMirrored,
    imagesFailed,
    images: images.length,
    priceNote,
    brandNote,
    colorNote,
    genderNote,
    styleNote,
    variantsLinked,
    ...(droppedColumns.length ? { droppedColumns } : {}),
    ...(newCardNote ? { linkNote: newCardNote } : {}),
  };
}
