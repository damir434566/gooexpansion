/**
 * Persist a parsed product into the catalog.
 *
 * Shared by the single-product import route and the bulk crawler. Deduping is by
 * `source_url`: re-importing the same page updates the existing row instead of
 * creating a twin, which is what makes a crawl safe to re-run.
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
import {
  chooseGroup,
  isColorSiblingByName,
  sameModelFamily,
  type VariantCandidate,
} from "./variant-group";
import {
  isSameItem,
  mergePatch,
  pickSameItemByName,
  withRetailer,
  type ExistingItem,
  type IncomingItem,
  type NamedItem,
} from "./same-item";
import { brandVocabulary, decideBrand } from "./brand-from-name";
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
let brandCache: { at: number; brands: string[] } | null = null;

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
  brandCache = { at: Date.now(), brands };
  return brands;
}

// ── Colour variants ───────────────────────────────────────────────────────────
// One colourway per page is how a store sells; one card per piece is how the
// catalogue shows. The CSV importer forms those groups inside a batch, but a
// collect run imports one page at a time, so grouping has to happen against the
// rows already in the table. Two signals, judged in `variant-group.ts`: the
// addresses the page's own colour row links to, and — only when the store
// switches colours with script instead of links — brand and base name.

interface VariantRow {
  id: string;
  name: string | null;
  colors: string[] | null;
  category: string | null;
  variant_group_id: string | null;
  is_group_primary: boolean | null;
}

function toCandidate(row: VariantRow): VariantCandidate {
  return {
    id: row.id,
    name: row.name ?? "",
    colors: row.colors ?? [],
    category: row.category,
    variantGroupId: row.variant_group_id,
    isGroupPrimary: row.is_group_primary,
  };
}

const VARIANT_COLUMNS = "id, name, colors, category, variant_group_id, is_group_primary";

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
      const { data } = await supabase!
        .from("products")
        .select(VARIANT_COLUMNS)
        .in("source_url", input.variantUrls.slice(0, 20));
      // The page's own colour row, checked once: a link is a colourway only
      // if it can be one. A "you may also like" grid with swatches on its
      // cards read as the colour row, and other jackets joined this one.
      const ours = { name: input.name, colors: input.colors, category: input.category };
      for (const row of (data ?? []) as VariantRow[]) {
        if (row.id === input.productId) continue;
        const candidate = toCandidate(row);
        if (sameModelFamily(input.brand, ours, candidate)) siblings.set(row.id, candidate);
      }
    }

    // Only when the page named no siblings: a store that links its colourways
    // has already given the exact answer, and the name test is the guess.
    if (!siblings.size && input.brand) {
      // The brand compared without case, so "NIKE" from one store and "Nike"
      // from another are one brand's rows.
      const { data } = await supabase!
        .from("products")
        .select(VARIANT_COLUMNS)
        .ilike("brand", escapeLike(input.brand))
        .limit(BRAND_ROWS);
      const ours = {
        brand: input.brand,
        name: input.name,
        colors: input.colors,
        category: input.category,
      };
      for (const row of (data ?? []) as VariantRow[]) {
        if (row.id === input.productId) continue;
        const candidate = toCandidate(row);
        if (isColorSiblingByName(ours, candidate)) siblings.set(row.id, candidate);
      }
    }

    // A group of one is not a group. When the page links colourways we have not
    // collected yet, nothing is written now: whichever of them is imported next
    // will find this row by its address and form the group then.
    if (!siblings.size) return 0;

    const list = [...siblings.values()];
    const { groupId, hasPrimary } = chooseGroup(list);
    const group = groupId ?? crypto.randomUUID();

    const orphans = list.filter((s) => !s.variantGroupId).map((s) => s.id);
    if (orphans.length) {
      await supabase!
        .from("products")
        .update({ variant_group_id: group })
        .in("id", orphans.slice(0, 20));
    }

    const { error } = await supabase!
      .from("products")
      .update({ variant_group_id: group, is_group_primary: !hasPrimary })
      .eq("id", input.productId);
    if (error) return 0;

    return list.length;
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
 * Asked by code only — GTIN, or the maker's part number together with the brand.
 * Returns null on any database complaint, including the one a database without
 * migration 020 makes, so a catalogue that has not run it keeps importing
 * exactly as it did before: a second row rather than a second link.
 */
async function findSameItem(incoming: IncomingItem, sourceUrl: string | null): Promise<ExistingItem | null> {
  try {
    const queries: PromiseLike<{ data: unknown; error: unknown }>[] = [];
    if (incoming.gtin) {
      queries.push(supabase!.from("products").select(MERGE_COLUMNS).eq("gtin", incoming.gtin).limit(5));
    }
    if (incoming.mpn && incoming.brand) {
      queries.push(
        supabase!
          .from("products")
          .select(MERGE_COLUMNS)
          .eq("mpn", incoming.mpn)
          .eq("brand", incoming.brand)
          .limit(5),
      );
    }
    if (!queries.length) return null;

    for (const query of queries) {
      const { data, error } = await query;
      if (error || !Array.isArray(data)) continue;
      for (const row of data as MergeRow[]) {
        // A row we are re-importing is an update, not a merge; that path has
        // already run by the time this is asked.
        if (sourceUrl && row.source_url === sourceUrl) continue;
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
  category: string;
  price: number;
  sourceUrl: string | null;
}): Promise<{ item: NamedItem; unread: string[] } | null> {
  if (!incoming.brand || !incoming.sourceUrl) return null;
  try {
    for (const columns of NAME_MATCH_COLUMNS) {
      const { data, error } = await supabase!
        .from("products")
        .select(columns)
        .ilike("brand", escapeLike(incoming.brand))
        .limit(BRAND_ROWS);
      if (error) continue;
      const rows: NamedItem[] = ((data ?? []) as unknown as (MergeRow & {
        name: string | null;
        category: string | null;
      })[]).map((row) => ({ ...toExisting(row), name: row.name ?? "", category: row.category }));
      const item = pickSameItemByName(incoming, rows);
      if (!item) return null;
      const read = columns.split(",").map((c) => c.trim());
      return { item, unread: FILL_ONLY_COLUMNS.filter((c) => !read.includes(c)) };
    }
  } catch {
    /* no connection — an ordinary insert, as before */
  }
  return null;
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
 */
async function keepOtherStores(
  dbRow: Record<string, unknown>,
  existing: Product["retailers"],
  ours: Product["retailers"][number] | undefined,
  sourceUrl: string | null,
): Promise<Record<string, unknown>> {
  if (!ours) return dbRow;
  const others = existing.filter(
    (r) => r?.url && r.url !== sourceUrl && r.name?.toLowerCase() !== ours.name.toLowerCase(),
  );
  if (!others.length) return dbRow;

  const row: Record<string, unknown> = { ...dbRow, retailers: withRetailer(existing, ours) };
  if (row.currency !== "USD") return row;

  const theirs = (
    await Promise.all(others.map((r) => toUsd(Number(r.price) || 0, r.currency || "USD")))
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

  let images = (Array.isArray(p.images) ? p.images : []).map(httpUrl).filter(Boolean).slice(0, MAX_PRODUCT_IMAGES);
  let imageUrl = httpUrl(p.imageUrl) || images[0] || "";

  // Mirror photos to our storage before writing the row, so the catalog only
  // ever references URLs we control. A failed download keeps its original URL.
  let imagesMirrored: number | undefined;
  let imagesFailed: number | undefined;
  if (opts.mirrorImages && (imageUrl || images.length)) {
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
  const sizes = (Array.isArray(p.sizes) ? p.sizes : [])
    .map((s: unknown) => String(s).trim())
    .filter(Boolean)
    .slice(0, 40);

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
  });
  const brand = brandDecision.brand.slice(0, 80);
  const brandNote = brandDecision.fromName
    ? `brand ${brand} from the name${statedBrand ? ` (page said ${statedBrand})` : ""}`
    : undefined;

  // The store's name and its "official store" flag come from the domain rules
  // when the admin has written one, and from the guesses made off the link only
  // when they haven't. This is the path the bookmarklet uses, so it is where a
  // mislabelled shop would otherwise enter the catalogue one product at a time.
  const retailerRules = sourceUrl ? await loadRetailerRules() : new Map();
  const resolved = sourceUrl ? resolveRetailer(sourceUrl, brand, retailerRules) : null;

  const retailers: Product["retailers"] = sourceUrl && resolved
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
  // habit in the catalogue). Style is mostly the brand's manner, which no page
  // spells out. Both are learned from the editor's own labelling — see
  // `catalogue-profile.ts` for what is trusted and why.
  const profile = await loadCatalogueProfile();
  let gender = statedGender;
  let genderNote: string | undefined;
  if (!gender) {
    const proposal = proposeGender(
      {
        brand,
        sourceUrl,
        storeDefault: sourceUrl ? storeDefaultGender(sourceUrl, retailerRules) : undefined,
      },
      profile,
    );
    if (proposal) {
      gender = proposal.gender;
      genderNote = `gender ${proposal.gender} from ${proposal.reason}`;
    }
  }
  const styleProposal = proposeStyles(
    { brand, keywordStyles: normalizeStyleKeywords(p.styleKeywords), colors, colorGroups: groupNames },
    profile,
  );
  let styleNote = styleProposal.styles.length ? `style ${styleProposal.reasons.join("; ")}` : undefined;

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
  // instead of every import failing on a column it has never heard of.
  const insert = (row: Record<string, unknown>) =>
    supabase!.from("products").insert(row).select("id").maybeSingle();

  let productId: string | null = null;
  let updated = false;
  try {
    let existingId: string | null = null;
    let existingRetailers: Product["retailers"] = [];
    let existingStyled = false;
    let existingGendered = false;
    if (sourceUrl) {
      const { data: existing } = await supabase
        .from("products").select("id, retailers, style_keywords, gender").eq("source_url", sourceUrl).maybeSingle();
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

    if (existingId) {
      const id = existingId;
      const row = await keepOtherStores(dbRow, existingRetailers, retailers[0], sourceUrl);
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
      const { data, error } = await writeProductRow<{ id: string }>(row, (r) =>
        supabase!.from("products").update(r).eq("id", id).select("id").maybeSingle(),
      );
      if (error) throw new Error(error.message);
      productId = data?.id ?? id;
      updated = true;
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
        // widen a dollar range with a hryvnia number.
        price: currency === "USD" ? price : 0,
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
      let twin: ExistingItem | null = await findSameItem(incoming, sourceUrl);
      let mergedBy: ImportResult["mergedBy"] = twin ? "code" : undefined;
      let unread: string[] = [];
      if (!twin) {
        const byName = await findSameItemByName({
          brand,
          name,
          colors,
          category,
          price: incoming.price,
          sourceUrl,
        });
        if (byName) {
          twin = byName.item;
          unread = byName.unread;
          mergedBy = "name";
        }
      }

      if (twin) {
        const twinId = twin.id;
        const merged = mergePatch(twin, incoming);
        const patch = merged.patch;
        for (const column of unread) delete patch[column];
        const filled = merged.filled.filter((f) => !unread.includes(f));
        // Merged prices are dollars on both sides, so the comparable scale is
        // the same number.
        if (patch.price_min !== undefined) patch.price_min_usd = patch.price_min;
        if (patch.price_max !== undefined) patch.price_max_usd = patch.price_max;
        const { error } = await writeProductRow<{ id: string }>(patch, (row) =>
          supabase!.from("products").update(row).eq("id", twinId).select("id").maybeSingle(),
        );
        if (error) throw new Error(error.message);
        return {
          ok: true,
          productId: twinId,
          updated: true,
          imagesMirrored,
          imagesFailed,
          images: images.length,
          priceNote,
          brandNote,
          colorNote,
          genderNote,
          styleNote,
          mergedInto: twinId,
          mergedBy,
          mergedFields: filled,
        };
      }

      const { data, error } = await writeProductRow<{ id: string }>(dbRow, insert);
      if (error) throw new Error(error.message);
      productId = data?.id ?? null;
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

  // Record an import job (best-effort — table is optional, ignore if absent).
  if (sourceUrl) {
    try {
      await supabase.from("import_jobs").insert({
        url: sourceUrl,
        status: "done",
        result_product_id: productId,
      });
    } catch { /* import_jobs not migrated — non-critical */ }
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
  };
}
