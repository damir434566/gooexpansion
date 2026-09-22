/**
 * Server-side data access layer.
 * Uses Supabase when configured, falls back to static data.
 */
import type { BlogPost, ColorGroup, Outfit, OutfitItem, Product, ProductSwatch } from "@/lib/types";
import { supabase, isSupabaseConfigured, type DbBlogPost, type DbOutfit, type DbProduct, type DbColorGroup, dbToColorGroup } from "@/lib/supabase";
import { products as staticProducts } from "./products";
import { outfits as staticOutfits } from "./outfits";
import { blogPosts as staticBlogPosts } from "./blog";
import { storeNameFromUrl, isOfficialStore } from "@/lib/server/product-fields";
import { findSupportedStore, storeFaviconUrl, storeHomepageUrl, type SupportedStore } from "@/lib/stores";
import { writeRowDroppingUnknown, type WriteError } from "@/lib/server/write-row";

// Older imports stored the *brand* as the store name (so "Where to buy" rows
// read e.g. "Supreme" instead of "Farfetch"). Correct those at read time:
// only when a retailer's name matches the brand AND its link resolves to a
// real, different store — leaving genuine official-store rows untouched.
function normalizeRetailers(
  retailers: Product["retailers"],
  brand: string,
): Product["retailers"] {
  const slug = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const brandSlug = slug(brand);
  if (!brandSlug || !Array.isArray(retailers)) return retailers ?? [];
  return retailers.map((r) => {
    if (!r?.url || slug(r.name) !== brandSlug) return r;
    // A row that says it *is* the brand's own shop is entitled to carry the
    // brand's name — that is what an official store is. The comment above has
    // always promised to leave those alone; the code never checked the flag, so
    // every official store had its name replaced by its own host on the way out
    // of the database ("Enfants Riches Déprimés" served as
    // "Enfantsrichesdeprimes"), and the flag was then recomputed to false by a
    // heuristic that cannot see through an accent.
    //
    // That also made retailer domain rules inert exactly where they matter
    // most: a rule naming a brand's own shop after the brand was undone on
    // every read, so applying it appeared to do nothing at all.
    if (r.isOfficial === true) return r;
    const derived = storeNameFromUrl(r.url, "");
    if (!derived || derived === "Store" || slug(derived) === brandSlug) return r;
    return { ...r, name: derived, isOfficial: isOfficialStore(r.url, brand) };
  });
}

function isWithinLastWeek(dateStr?: string): boolean {
  if (!dateStr) return false;
  return Date.now() - new Date(dateStr).getTime() < 7 * 24 * 60 * 60 * 1000;
}

function shuffleArray<T>(arr: T[]): T[] {
  let s = 0x4a3f2e1d;
  const rng = () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s / 0x100000000;
  };
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function dbToProduct(row: DbProduct): Product {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand as Product["brand"],
    category: row.category as Product["category"],
    subcategory: row.subcategory ?? undefined,
    description: row.description ?? "",
    // Serve the exact stored URLs. Higher-resolution variants are requested at
    // render time by the image component, which falls back to these originals
    // if a CDN won't serve the upscaled size — so a photo never disappears.
    imageUrl: row.image_url ?? "",
    images: row.images ?? [],
    colors: row.colors ?? [],
    colorImages: row.color_images ?? undefined,
    sizes: row.sizes ?? [],
    material: row.material ?? "",
    retailers: normalizeRetailers((row.retailers as Product["retailers"]) ?? [], row.brand),
    priceMin: row.price_min,
    priceMax: row.price_max,
    currency: row.currency ?? "USD",
    isNew: (row.is_new ?? false) && isWithinLastWeek(row.created_at),
    isSaved: row.is_saved ?? false,
    styleKeywords: (row.style_keywords ?? []) as Product["styleKeywords"],
    gender: (row.gender ?? undefined) as Product["gender"],
    variantGroupId: row.variant_group_id ?? undefined,
    colorHex: row.color_hex ?? undefined,
    isGroupPrimary: row.is_group_primary ?? undefined,
    cropData: row.crop_data ?? undefined,
    colorGroupIds: row.color_group_ids?.length ? row.color_group_ids : undefined,
    createdAt: row.created_at,
    bgColor: row.bg_color ?? undefined,
    sourcePrice: row.source_price ?? undefined,
    sourceCurrency: row.source_currency ?? undefined,
    fxRate: row.fx_rate ?? undefined,
    fxDate: row.fx_date ?? undefined,
    gtin: row.gtin ?? undefined,
    mpn: row.mpn ?? undefined,
    sku: row.sku ?? undefined,
  };
}

export function productToDb(p: Partial<Product>) {
  const base = {
    name: p.name ?? "",
    brand: p.brand ?? "",
    category: p.category ?? "",
    description: p.description ?? "",
    image_url: p.imageUrl ?? "",
    images: p.images ?? [],
    colors: p.colors ?? [],
    sizes: p.sizes ?? [],
    material: p.material ?? "",
    retailers: p.retailers ?? [],
    price_min: p.priceMin ?? 0,
    price_max: p.priceMax ?? p.priceMin ?? 0,
    currency: p.currency ?? "USD",
    is_new: p.isNew ?? false,
    is_saved: p.isSaved ?? false,
    style_keywords: p.styleKeywords ?? [],
  };
  const extras: Record<string, unknown> = {};
  if (p.colorImages && Object.keys(p.colorImages).length > 0) {
    extras.color_images = p.colorImages;
  }
  if (p.gender) extras.gender = p.gender;
  // Sent only when the caller has an opinion, so importers that predate the
  // column keep working against a database that has not run migration 010.
  // An empty string means "cleared", which is a null rather than a no-op.
  if (p.subcategory !== undefined) extras.subcategory = p.subcategory || null;
  if (p.variantGroupId !== undefined) extras.variant_group_id = p.variantGroupId ?? null;
  if (p.colorHex !== undefined)       extras.color_hex = p.colorHex ?? null;
  if (p.isGroupPrimary !== undefined) extras.is_group_primary = p.isGroupPrimary ?? false;
  if (p.cropData !== undefined)       extras.crop_data = p.cropData ?? null;
  if (p.colorGroupIds !== undefined)  extras.color_group_ids = p.colorGroupIds ?? [];
  if (p.bgColor !== undefined)        extras.bg_color = p.bgColor ?? null;
  // The store's own price, kept beside the catalogue's converted one.
  if (p.sourcePrice !== undefined)    extras.source_price = p.sourcePrice ?? null;
  if (p.sourceCurrency !== undefined) extras.source_currency = p.sourceCurrency || null;
  if (p.fxRate !== undefined)         extras.fx_rate = p.fxRate ?? null;
  if (p.fxDate !== undefined)         extras.fx_date = p.fxDate || null;
  // Codes that identify the item, not the listing.
  if (p.gtin !== undefined)           extras.gtin = p.gtin || null;
  if (p.mpn !== undefined)            extras.mpn = p.mpn || null;
  if (p.sku !== undefined)            extras.sku = p.sku || null;
  return { ...base, ...extras };
}

/**
 * Columns that arrived with a migration and may not exist yet on a database
 * the code has been deployed ahead of.
 */
const OPTIONAL_COLUMNS = [
  "subcategory",
  "color_group_ids",
  "crop_data",
  "color_images",
  "variant_group_id",
  "color_hex",
  "is_group_primary",
  "bg_color",
  "source_price",
  "source_currency",
  "fx_rate",
  "fx_date",
  "gtin",
  "mpn",
  "sku",
];

/**
 * Runs a product write, dropping optional columns the database does not have
 * and retrying rather than failing the whole save.
 *
 * Without this, deploying before running a migration takes down the entire
 * product editor — every save carries the new column, so nothing can be saved
 * at all, not just the field the migration added. The dropped names come back
 * so the caller can say what did not persist instead of silently losing it.
 *
 * The mechanism itself lives in lib/server/write-row, because the look
 * submission pipeline needs the same behaviour for its own optional columns.
 */
export function writeProductRow<T>(
  row: Record<string, unknown>,
  // Supabase query builders are thenable rather than real Promises.
  write: (row: Record<string, unknown>) => PromiseLike<{ data: T | null; error: WriteError | null }>,
) {
  return writeRowDroppingUnknown(row, OPTIONAL_COLUMNS, write);
}

/** Names the columns a save could not write, and why. */
export function missingColumnWarning(dropped: string[]): string {
  return `Saved, but ${dropped.join(", ")} ${dropped.length > 1 ? "were" : "was"} not stored — the database is missing ${dropped.length > 1 ? "those columns" : "that column"}. Run the pending migration in supabase/migrations.`;
}

const DEFAULT_COLOR_GROUPS: ColorGroup[] = [
  { id: 1,  name: "White",      hexCode: "#ffffff",     sortOrder: 1 },
  { id: 2,  name: "Multicolor", hexCode: "#multicolor", sortOrder: 2 },
  { id: 3,  name: "Brown",      hexCode: "#7a4f35",     sortOrder: 3 },
  { id: 4,  name: "Pink",       hexCode: "#e8698a",     sortOrder: 4 },
  { id: 5,  name: "Yellow",     hexCode: "#f5c518",     sortOrder: 5 },
  { id: 6,  name: "Orange",     hexCode: "#e87722",     sortOrder: 6 },
  { id: 7,  name: "Grey",       hexCode: "#808080",     sortOrder: 7 },
  { id: 8,  name: "Black",      hexCode: "#111111",     sortOrder: 8 },
  { id: 9,  name: "Green",      hexCode: "#2d6a3f",     sortOrder: 9 },
  { id: 10, name: "Red",        hexCode: "#c0392b",     sortOrder: 10 },
  { id: 11, name: "Violet",     hexCode: "#7b3fa0",     sortOrder: 11 },
  { id: 12, name: "Blue",       hexCode: "#1a47a0",     sortOrder: 12 },
  { id: 13, name: "Beige",      hexCode: "#d4c5a9",     sortOrder: 13 },
];

/**
 * Fetches all base color groups from Supabase (used in the filter sidebar).
 * Falls back to DEFAULT_COLOR_GROUPS if Supabase is not configured.
 */
export async function getAllColorGroups(): Promise<ColorGroup[]> {
  if (!isSupabaseConfigured || !supabase) return DEFAULT_COLOR_GROUPS;
  const { data, error } = await supabase
    .from("color_groups")
    .select("*")
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[db] getAllColorGroups:", error.message);
    return DEFAULT_COLOR_GROUPS;
  }
  return (data as DbColorGroup[]).map(dbToColorGroup);
}

/**
 * Build a lightweight swatch from a product row.
 * colorName falls back to the first listed color then the product name.
 */
function toSwatch(p: Product): ProductSwatch {
  return {
    id:            p.id,
    name:          p.name,
    colorName:     p.colors?.[0] || p.name,
    colorHex:      p.colorHex ?? "#888888",
    priceMin:      p.priceMin,
    priceMax:      p.priceMax,
    imageUrl:      p.imageUrl,
    images:        p.images ?? [],
    sizes:         p.sizes ?? [],
    colorGroupIds: p.colorGroupIds,
    bgColor:       p.bgColor,
  };
}

/**
 * Fetches all products and groups linked variants.
 *
 * Products with the same variantGroupId are merged:
 * – The primary product (isGroupPrimary=true) appears in the list with a
 *   `variants` array containing swatches of all siblings (including itself).
 * – Non-primary products in a group are removed from the top-level list.
 * – Products without a group are returned unchanged.
 */
export async function getAllProducts(skipGrouping = false): Promise<Product[]> {
  if (!isSupabaseConfigured || !supabase) return staticProducts;

  const PAGE = 1000;
  const allData: DbProduct[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("[db] getAllProducts:", error.message);
      return [];
    }

    allData.push(...(data as DbProduct[]));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }

  const all = allData.map(dbToProduct);
  const grouped = skipGrouping ? all : groupVariants(all);
  // Admin view (skipGrouping=true) keeps the deterministic newest-first order from
  // the DB query so the table doesn't reshuffle on every refresh. The public catalog
  // stays shuffled for visual variety between visits.
  return skipGrouping ? grouped : shuffleArray(grouped);
}

/**
 * Group products by variantGroupId, attaching swatches to the primary.
 * Products not in any group pass through unmodified.
 */
export function groupVariants(all: Product[]): Product[] {
  // Collect all groups: groupId → list of products
  const groups = new Map<string, Product[]>();
  const ungrouped: Product[] = [];

  for (const p of all) {
    if (p.variantGroupId) {
      const list = groups.get(p.variantGroupId) ?? [];
      list.push(p);
      groups.set(p.variantGroupId, list);
    } else {
      ungrouped.push(p);
    }
  }

  const grouped: Product[] = [];
  for (const [, members] of groups) {
    // Find primary; fall back to first member if none explicitly marked
    const primary = members.find((m) => m.isGroupPrimary) ?? members[0];
    const swatches = members.map(toSwatch);
    // Merge colorGroupIds from all variants so any member's color shows in filters
    const mergedColorGroupIds = [
      ...new Set(members.flatMap((m) => m.colorGroupIds ?? [])),
    ];
    grouped.push({
      ...primary,
      variants: swatches,
      colorGroupIds: mergedColorGroupIds.length ? mergedColorGroupIds : primary.colorGroupIds,
    });
  }

  // Preserve original ordering: ungrouped products stay in their positions
  const result: Product[] = [];
  for (const p of all) {
    if (!p.variantGroupId) {
      result.push(p);
    } else if ((p.isGroupPrimary || !groups.get(p.variantGroupId)?.find((m) => m.isGroupPrimary)) &&
               p.id === (groups.get(p.variantGroupId)?.find((m) => m.isGroupPrimary) ?? groups.get(p.variantGroupId)?.[0])?.id) {
      const withVariants = grouped.find((g) => g.id === p.id);
      if (withVariants) result.push(withVariants);
    }
    // non-primary members of a group are silently skipped
  }

  return result;
}

export async function getProductById(id: string): Promise<Product | undefined> {
  if (!isSupabaseConfigured || !supabase) return undefined;
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !data) return undefined;
  const product = dbToProduct(data as DbProduct);

  // If part of a variant group, fetch all siblings and attach as swatches
  if (product.variantGroupId) {
    const { data: siblings } = await supabase
      .from("products")
      .select("*")
      .eq("variant_group_id", product.variantGroupId);
    if (siblings && siblings.length > 0) {
      product.variants = (siblings as DbProduct[]).map(dbToProduct).map(toSwatch);
    }
  }

  return product;
}

export async function getProductsByCategory(category: string): Promise<Product[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("category", category)
    .order("created_at", { ascending: false });
  if (error) return [];
  return shuffleArray(groupVariants((data as DbProduct[]).map(dbToProduct)));
}

// ============================================================
// Outfit CRUD
// ============================================================

/**
 * Converts a DB outfit row (with product_id references) to a full Outfit object
 * by looking up products from the provided map.
 */
function dbToOutfit(row: DbOutfit, productMap: Map<string, Product>): Outfit {
  const items: OutfitItem[] = [];
  for (const item of row.items ?? []) {
    const product = productMap.get(item.product_id);
    if (product) {
      items.push({ product, role: item.role, selectedColor: item.selected_color });
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    occasion: row.occasion as Outfit["occasion"],
    imageUrl: row.image_url ?? "",
    items,
    totalPriceMin: row.total_price_min,
    totalPriceMax: row.total_price_max,
    currency: row.currency ?? "USD",
    styleKeywords: (row.style_keywords ?? []) as Outfit["styleKeywords"],
    isAIGenerated: row.is_ai_generated ?? false,
    isSaved: row.is_saved ?? false,
    season: (row.season ?? "all") as Outfit["season"],
    source: (row.source === "community" ? "community" : null),
    isHomepageFeatured: row.is_homepage_featured ?? false,
    createdAt: row.created_at,
  };
}

export interface OutfitApiBody {
  name?: string;
  description?: string;
  occasion?: string;
  imageUrl?: string;
  items?: { productId: string; role: string; selectedColor?: string }[];
  totalPriceMin?: number;
  totalPriceMax?: number;
  currency?: string;
  styleKeywords?: string[];
  isAIGenerated?: boolean;
  isSaved?: boolean;
  season?: string;
}

export function outfitToDb(o: OutfitApiBody) {
  return {
    name: o.name ?? "",
    description: o.description ?? "",
    occasion: o.occasion ?? "casual",
    image_url: o.imageUrl ?? "",
    items: (o.items ?? []).map((i) => ({ product_id: i.productId, role: i.role, selected_color: i.selectedColor })),
    total_price_min: o.totalPriceMin ?? 0,
    total_price_max: o.totalPriceMax ?? o.totalPriceMin ?? 0,
    currency: o.currency ?? "USD",
    style_keywords: o.styleKeywords ?? [],
    is_ai_generated: o.isAIGenerated ?? false,
    is_saved: o.isSaved ?? false,
    season: o.season ?? "all",
  };
}

export async function getAllOutfits(): Promise<Outfit[]> {
  if (!isSupabaseConfigured || !supabase) return staticOutfits;

  const { data, error } = await supabase
    .from("outfits")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[db] getAllOutfits:", error.message);
    return staticOutfits;
  }

  const rows = data as DbOutfit[];
  if (rows.length === 0) return staticOutfits;

  // Collect all product IDs referenced across all outfits
  const productIds = [...new Set(rows.flatMap((r) => (r.items ?? []).map((i) => i.product_id)))];

  const productMap = new Map<string, Product>();
  if (productIds.length > 0) {
    // Fetch in batches of 200 to avoid URL-too-long errors with PostgREST .in() filters
    const BATCH = 200;
    for (let i = 0; i < productIds.length; i += BATCH) {
      const batch = productIds.slice(i, i + BATCH);
      const { data: prodData } = await supabase
        .from("products")
        .select("*")
        .in("id", batch);
      if (prodData) {
        for (const p of (prodData as DbProduct[]).map(dbToProduct)) {
          productMap.set(p.id, p);
        }
      }
    }
  }

  return rows.map((r) => dbToOutfit(r, productMap));
}

export async function createOutfit(
  data: ReturnType<typeof outfitToDb>
): Promise<{ outfit: Outfit | null; error: string | null }> {
  if (!isSupabaseConfigured || !supabase) return { outfit: null, error: "Database not configured." };

  const { data: row, error } = await supabase
    .from("outfits")
    .insert(data)
    .select()
    .single();

  if (error) {
    console.error("[db] createOutfit:", error.message);
    return { outfit: null, error: error.message };
  }

  // Hydrate returned row
  const productIds = (row.items ?? []).map((i: { product_id: string }) => i.product_id);
  const productMap = new Map<string, Product>();
  if (productIds.length > 0) {
    const { data: prodData } = await supabase
      .from("products")
      .select("*")
      .in("id", productIds);
    if (prodData) {
      for (const p of (prodData as DbProduct[]).map(dbToProduct)) {
        productMap.set(p.id, p);
      }
    }
  }

  return { outfit: dbToOutfit(row as DbOutfit, productMap), error: null };
}

export async function updateOutfit(
  id: string,
  data: ReturnType<typeof outfitToDb>
): Promise<Outfit | null> {
  if (!isSupabaseConfigured || !supabase) return null;

  const { data: row, error } = await supabase
    .from("outfits")
    .update(data)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[db] updateOutfit:", error.message);
    return null;
  }

  const productIds = (row.items ?? []).map((i: { product_id: string }) => i.product_id);
  const productMap = new Map<string, Product>();
  if (productIds.length > 0) {
    const { data: prodData } = await supabase
      .from("products")
      .select("*")
      .in("id", productIds);
    if (prodData) {
      for (const p of (prodData as DbProduct[]).map(dbToProduct)) {
        productMap.set(p.id, p);
      }
    }
  }

  return dbToOutfit(row as DbOutfit, productMap);
}

export async function getOutfitById(id: string): Promise<Outfit | undefined> {
  if (!isSupabaseConfigured || !supabase) {
    return staticOutfits.find((o) => o.id === id);
  }

  const { data, error } = await supabase
    .from("outfits")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    // Fall back to static data
    return staticOutfits.find((o) => o.id === id);
  }

  const row = data as DbOutfit;
  const productIds = (row.items ?? []).map((i) => i.product_id);
  const productMap = new Map<string, Product>();
  if (productIds.length > 0) {
    const { data: prodData } = await supabase
      .from("products")
      .select("*")
      .in("id", productIds);
    if (prodData) {
      for (const p of (prodData as DbProduct[]).map(dbToProduct)) {
        productMap.set(p.id, p);
      }
    }
  }

  return dbToOutfit(row, productMap);
}

/**
 * A user-created builder look, resolved against the product catalog so it can
 * be rendered on a public share page the same way published outfits are. Reads
 * straight from `user_looks` by id (service-role), so anyone with the link can
 * view it without being the owner.
 */
export interface SharedLookPiece {
  slot: string;
  productId: string;
  name: string;
  imageUrl: string | null;
  brand: string | null;
  priceMin: number | null;
  retailerCount: number;
  /** False when the referenced product is no longer in the catalog. */
  productExists: boolean;
}

export interface SharedLook {
  id: string;
  name: string | null;
  description: string | null;
  generatedImage: string | null;
  generatedStyle: string | null;
  totalPrice: number | null;
  styleKeywords: string[];
  savedAt: string | null;
  pieces: SharedLookPiece[];
}

type RawLookPiece = {
  slot?: unknown;
  productId?: unknown;
  imageUrl?: unknown;
  name?: unknown;
};

/** Resolve raw look-piece refs against the catalog (brand, price, stores). */
async function enrichSharedLookPieces(raw: unknown): Promise<SharedLookPiece[]> {
  const rawPieces = (Array.isArray(raw) ? raw : []).filter(
    (p): p is RawLookPiece => !!p && typeof p === "object"
  );

  const productIds = rawPieces
    .map((p) => (typeof p.productId === "string" ? p.productId : null))
    .filter((id): id is string => !!id);

  const productMap = new Map<string, Product>();
  if (productIds.length > 0) {
    if (isSupabaseConfigured && supabase) {
      const { data: prodData } = await supabase
        .from("products")
        .select("*")
        .in("id", productIds);
      if (prodData) {
        for (const p of (prodData as DbProduct[]).map(dbToProduct)) {
          productMap.set(p.id, p);
        }
      }
    } else {
      for (const p of staticProducts) {
        if (productIds.includes(p.id)) productMap.set(p.id, p);
      }
    }
  }

  return rawPieces.map((p) => {
    const productId = typeof p.productId === "string" ? p.productId : "";
    const product = productMap.get(productId);
    const slot = typeof p.slot === "string" ? p.slot : "";
    return {
      slot,
      productId,
      name: (typeof p.name === "string" && p.name ? p.name : product?.name) ?? slot,
      imageUrl:
        (typeof p.imageUrl === "string" && p.imageUrl ? p.imageUrl : product?.imageUrl) ?? null,
      brand: product?.brand ?? null,
      priceMin: product?.priceMin ?? null,
      retailerCount: product?.retailers?.length ?? 0,
      productExists: !!product,
    };
  });
}

export async function getUserLookById(id: string): Promise<SharedLook | null> {
  if (!isSupabaseConfigured || !supabase) return null;

  const { data, error } = await supabase
    .from("user_looks")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return null;

  const pieces = await enrichSharedLookPieces(data.pieces);

  const generatedStyle =
    typeof data.generated_style === "string" ? data.generated_style : null;

  return {
    id: data.id,
    name: data.look_name ?? null,
    description: data.look_description ?? null,
    generatedImage: data.generated_image ?? null,
    generatedStyle,
    totalPrice: data.total_price ?? null,
    styleKeywords: Array.isArray(data.style_keywords) ? data.style_keywords : [],
    savedAt: data.saved_at ?? null,
    pieces,
  };
}

/**
 * Fallback for share links that carry the look in the URL itself (?d=...).
 * Used when the look never reached the database (e.g. the write failed at
 * share time) — the link must still open the standard look page for any
 * recipient. The payload is untrusted URL input, so every field is validated
 * and images are restricted to http(s) URLs.
 */
export async function sharedLookFromShareData(
  id: string,
  encoded: string
): Promise<SharedLook | null> {
  let data: Record<string, unknown>;
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null;
  const httpUrl = (v: unknown) => {
    const s = str(v, 2000);
    return s && /^https?:\/\//.test(s) ? s : null;
  };

  const rawPieces = (Array.isArray(data.pieces) ? data.pieces : [])
    .slice(0, 12)
    .map((p: RawLookPiece) => ({
      slot: str(p?.slot, 40) ?? "",
      productId: str(p?.productId, 100) ?? "",
      name: str(p?.name, 300) ?? undefined,
      imageUrl: httpUrl(p?.imageUrl) ?? undefined,
    }))
    .filter((p) => p.productId);

  const pieces = await enrichSharedLookPieces(rawPieces);
  if (pieces.length === 0) return null;

  return {
    id,
    name: str(data.name, 200),
    description: str(data.description, 2000),
    generatedImage: httpUrl(data.generatedImage),
    generatedStyle: str(data.generatedStyle, 40),
    totalPrice:
      typeof data.totalPrice === "number" && Number.isFinite(data.totalPrice)
        ? data.totalPrice
        : null,
    styleKeywords: Array.isArray(data.styleKeywords)
      ? (data.styleKeywords as unknown[])
          .filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 60)
          .slice(0, 20)
      : [],
    savedAt: null,
    pieces,
  };
}

export async function getOutfitsByProductId(productIds: string | string[]): Promise<Outfit[]> {
  const ids = Array.isArray(productIds) ? productIds : [productIds];
  const all = await getAllOutfits();
  return all.filter((outfit) => outfit.items.some((item) => ids.includes(item.product.id)));
}

export async function toggleOutfitHomepageFeatured(
  id: string,
  featured: boolean
): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  const { error } = await supabase
    .from("outfits")
    .update({ is_homepage_featured: featured })
    .eq("id", id);
  if (error) {
    console.error("[db] toggleOutfitHomepageFeatured:", error.message);
    return false;
  }
  return true;
}

export async function getFeaturedOutfits(): Promise<Outfit[]> {
  if (!isSupabaseConfigured || !supabase) {
    return staticOutfits.slice(0, 3);
  }

  const { data, error } = await supabase
    .from("outfits")
    .select("*")
    .eq("is_homepage_featured", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[db] getFeaturedOutfits:", error.message);
    return staticOutfits.slice(0, 3);
  }

  const rows = (data ?? []) as DbOutfit[];

  // Fallback: if nothing is marked featured, return the 3 most recent outfits
  if (rows.length === 0) {
    const all = await getAllOutfits();
    return all.slice(0, 3);
  }

  const productIds = [...new Set(rows.flatMap((r) => (r.items ?? []).map((i) => i.product_id)))];
  const productMap = new Map<string, Product>();
  if (productIds.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < productIds.length; i += BATCH) {
      const batch = productIds.slice(i, i + BATCH);
      const { data: prodData } = await supabase
        .from("products")
        .select("*")
        .in("id", batch);
      if (prodData) {
        for (const p of (prodData as DbProduct[]).map(dbToProduct)) {
          productMap.set(p.id, p);
        }
      }
    }
  }

  return rows.map((r) => dbToOutfit(r, productMap));
}

export async function deleteOutfit(id: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  const { error } = await supabase.from("outfits").delete().eq("id", id);
  if (error) {
    console.error("[db] deleteOutfit:", error.message);
    return false;
  }
  return true;
}

// ─── Blog posts ─────────────────────────────────────────────────────────────

export function dbToBlogPost(row: DbBlogPost): BlogPost {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt ?? "",
    body: row.body ?? "",
    category: row.category ?? "General",
    coverImageUrl: row.cover_image_url ?? "",
    readTime: row.read_time ?? "5 min",
    authorName: row.author_name ?? "GOO",
    metaTitle: row.meta_title ?? undefined,
    metaDescription: row.meta_description ?? undefined,
    ogImage: row.og_image ?? undefined,
    isPublished: row.is_published ?? true,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function blogPostToDb(p: Partial<BlogPost>) {
  const row: Record<string, unknown> = {
    slug: p.slug ?? "",
    title: p.title ?? "",
    excerpt: p.excerpt ?? "",
    body: p.body ?? "",
    category: p.category ?? "General",
    cover_image_url: p.coverImageUrl ?? "",
    read_time: p.readTime ?? "5 min",
    author_name: p.authorName ?? "GOO",
    meta_title: p.metaTitle ?? null,
    meta_description: p.metaDescription ?? null,
    og_image: p.ogImage ?? null,
    is_published: p.isPublished ?? true,
  };
  if (p.publishedAt) row.published_at = p.publishedAt;
  return row;
}

export async function getAllBlogPosts(opts: { publishedOnly?: boolean } = {}): Promise<BlogPost[]> {
  const { publishedOnly = false } = opts;
  if (!isSupabaseConfigured || !supabase) {
    return publishedOnly ? staticBlogPosts.filter((p) => p.isPublished) : staticBlogPosts;
  }

  let query = supabase.from("blog_posts").select("*").order("published_at", { ascending: false });
  if (publishedOnly) query = query.eq("is_published", true);

  const { data, error } = await query;
  if (error) {
    console.error("[db] getAllBlogPosts:", error.message);
    return publishedOnly ? staticBlogPosts.filter((p) => p.isPublished) : staticBlogPosts;
  }

  const rows = (data ?? []) as DbBlogPost[];
  if (rows.length === 0) {
    return publishedOnly ? staticBlogPosts.filter((p) => p.isPublished) : staticBlogPosts;
  }
  return rows.map(dbToBlogPost);
}

export async function getBlogPostBySlug(slug: string): Promise<BlogPost | undefined> {
  if (!isSupabaseConfigured || !supabase) {
    return staticBlogPosts.find((p) => p.slug === slug);
  }
  const { data, error } = await supabase
    .from("blog_posts")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) {
    return staticBlogPosts.find((p) => p.slug === slug);
  }
  return dbToBlogPost(data as DbBlogPost);
}

export async function createBlogPost(
  data: ReturnType<typeof blogPostToDb>
): Promise<{ post: BlogPost | null; error: string | null }> {
  if (!isSupabaseConfigured || !supabase) {
    return { post: null, error: "Database not configured." };
  }
  const { data: row, error } = await supabase
    .from("blog_posts")
    .insert(data)
    .select()
    .single();
  if (error) {
    console.error("[db] createBlogPost:", error.message);
    return { post: null, error: error.message };
  }
  return { post: dbToBlogPost(row as DbBlogPost), error: null };
}

export async function updateBlogPost(
  id: string,
  data: ReturnType<typeof blogPostToDb>
): Promise<{ post: BlogPost | null; error: string | null }> {
  if (!isSupabaseConfigured || !supabase) {
    return { post: null, error: "Database not configured." };
  }
  const { data: row, error } = await supabase
    .from("blog_posts")
    .update(data)
    .eq("id", id)
    .select()
    .single();
  if (error) {
    console.error("[db] updateBlogPost:", error.message);
    return { post: null, error: error.message };
  }
  return { post: dbToBlogPost(row as DbBlogPost), error: null };
}

export async function deleteBlogPost(id: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  const { error } = await supabase.from("blog_posts").delete().eq("id", id);
  if (error) {
    console.error("[db] deleteBlogPost:", error.message);
    return false;
  }
  return true;
}

// ── HOMEPAGE SHOWCASE ("How it works" section) ───────────────────────────────
// Admins pick which existing products appear in each of the four steps. Stored
// as a single settings row (key = "homepage_showcase") holding product-id lists.

const SHOWCASE_KEY = "homepage_showcase";
const SHOWCASE_STEPS = ["step1", "step2", "step3", "step4"] as const;
export type ShowcaseStep = (typeof SHOWCASE_STEPS)[number];
export type HomepageShowcaseIds = Record<ShowcaseStep, string[]>;

export interface ShowcaseItem {
  id: string;
  name: string;
  imageUrl: string;
}
export type HomepageShowcase = Record<ShowcaseStep, ShowcaseItem[]>;

function emptyShowcaseIds(): HomepageShowcaseIds {
  return { step1: [], step2: [], step3: [], step4: [] };
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Raw product-id lists per step (used by the admin editor). */
export async function getHomepageShowcaseIds(): Promise<HomepageShowcaseIds> {
  if (!isSupabaseConfigured || !supabase) return emptyShowcaseIds();
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", SHOWCASE_KEY)
    .maybeSingle();
  const raw = (data as { value: string } | null)?.value;
  if (!raw) return emptyShowcaseIds();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = emptyShowcaseIds();
    for (const step of SHOWCASE_STEPS) out[step] = asStringArray(parsed[step]);
    return out;
  } catch {
    return emptyShowcaseIds();
  }
}

/**
 * Resolved items per step (used by the public homepage). Steps 1/2/4 reference
 * individual products; step 3 ("Generate preview") references a generated
 * outfit/look and uses its preview image.
 */
export async function getHomepageShowcase(): Promise<HomepageShowcase> {
  const ids = await getHomepageShowcaseIds();
  const productWanted = new Set([...ids.step1, ...ids.step2, ...ids.step4]);
  const outfitWanted = new Set(ids.step3);
  if (productWanted.size === 0 && outfitWanted.size === 0) {
    return { step1: [], step2: [], step3: [], step4: [] };
  }

  const productById = new Map<string, ShowcaseItem>();
  if (productWanted.size > 0) {
    const all = await getAllProducts(true);
    for (const p of all) {
      if (productWanted.has(p.id)) productById.set(p.id, { id: p.id, name: p.name, imageUrl: p.imageUrl });
    }
  }

  const outfitById = new Map<string, ShowcaseItem>();
  if (outfitWanted.size > 0) {
    const all = await getAllOutfits();
    for (const o of all) {
      if (outfitWanted.has(o.id)) outfitById.set(o.id, { id: o.id, name: o.name, imageUrl: o.imageUrl });
    }
  }

  const fromProducts = (arr: string[]) =>
    arr.map((id) => productById.get(id)).filter((x): x is ShowcaseItem => Boolean(x));
  const fromOutfits = (arr: string[]) =>
    arr.map((id) => outfitById.get(id)).filter((x): x is ShowcaseItem => Boolean(x));

  return {
    step1: fromProducts(ids.step1),
    step2: fromProducts(ids.step2),
    step3: fromOutfits(ids.step3),
    step4: fromProducts(ids.step4),
  };
}

// ── HOMEPAGE AI STYLIST SHOWCASE ─────────────────────────────────────────────
// Drives the "Your style. Found by AI." section on the homepage. Admins pick:
//   • up to 2 outfits ("looks") rendered as cards inside the chat preview, and
//   • one featured product shown bottom-left with its "Where to buy" retailers.
// Stored as a single settings row (key = "homepage_stylist").

const STYLIST_KEY = "homepage_stylist";
const MAX_CHAT_LOOKS = 2;
const MAX_SHOWCASE_STORES = 6;

/** A trending "look" card shown inside the chat preview. */
export interface StylistChatLook {
  id: string;
  name: string;
  imageUrl: string;
  price: number;
  currency: string;
}

/** An admin-added extra store shown in the homepage "Where to buy" list. */
export interface ShowcaseStore {
  name: string;
  logoUrl: string | null;
  /** Admin-set price tag for this store, or null when not set. */
  price: number | null;
  /** Store homepage URL — clicking the row opens this store. */
  url: string | null;
}

/** One extra store as stored in settings (name + admin-set price). */
export interface ExtraStore {
  name: string;
  price: number | null;
}

/** Raw ids stored in settings (used by the admin editor). */
export interface HomepageStylistIds {
  chatOutfits: string[];
  featuredProduct: string | null;
  /**
   * Extra stores the admin added to the "Where to buy" list, on top of the
   * featured item's own retailers (which always show automatically). Each has
   * an admin-set price; the logo is pulled from the store library by name.
   */
  extraStores: ExtraStore[];
}

/** Resolved data consumed by the public homepage. */
export interface HomepageStylist {
  chatLooks: StylistChatLook[];
  featuredProduct: Product | null;
  /** Lower-cased store name → logo URL, used to badge "Where to buy" rows. */
  retailerLogos: Record<string, string>;
  /**
   * Admin-added extra stores shown after the featured item's own retailers in
   * the "Where to buy" list (logo pulled from the library, admin-set price).
   */
  showcaseStores: ShowcaseStore[];
}

/**
 * Brand name → logo URL map (lower-cased keys). Resilient to the brands table
 * or the logo_url column not existing yet, in which case it returns {}.
 */
export async function getBrandLogos(): Promise<Record<string, string>> {
  if (!isSupabaseConfigured || !supabase) return {};
  const { data, error } = await supabase.from("brands").select("name, logo_url");
  if (error || !data) return {};
  const map: Record<string, string> = {};
  for (const row of data as { name: string; logo_url: string | null }[]) {
    if (row.name && row.logo_url) map[row.name.toLowerCase()] = row.logo_url;
  }
  return map;
}

function emptyStylistIds(): HomepageStylistIds {
  return { chatOutfits: [], featuredProduct: null, extraStores: [] };
}

/** Coerce a stored value into an ExtraStore list, accepting legacy string[] names. */
function asExtraStores(value: unknown): ExtraStore[] {
  if (!Array.isArray(value)) return [];
  const out: ExtraStore[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      out.push({ name: item.trim(), price: null });
    } else if (item && typeof item === "object") {
      const name = (item as Record<string, unknown>).name;
      const price = (item as Record<string, unknown>).price;
      if (typeof name === "string" && name.trim()) {
        out.push({
          name: name.trim(),
          price: typeof price === "number" && price > 0 ? price : null,
        });
      }
    }
  }
  return out;
}

/** Raw selection (used by the admin editor). */
export async function getHomepageStylistIds(): Promise<HomepageStylistIds> {
  if (!isSupabaseConfigured || !supabase) return emptyStylistIds();
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", STYLIST_KEY)
    .maybeSingle();
  const raw = (data as { value: string } | null)?.value;
  if (!raw) return emptyStylistIds();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // `extraStores` is the current field; legacy `stores`/`brands` were string
    // arrays of names (no price) and are still read for back-compat.
    const extraStores = asExtraStores(
      parsed.extraStores ?? parsed.stores ?? parsed.brands
    ).slice(0, MAX_SHOWCASE_STORES);
    return {
      chatOutfits: asStringArray(parsed.chatOutfits).slice(0, MAX_CHAT_LOOKS),
      featuredProduct:
        typeof parsed.featuredProduct === "string" ? parsed.featuredProduct : null,
      extraStores,
    };
  } catch {
    return emptyStylistIds();
  }
}

/**
 * Resolved stylist showcase for the homepage. Falls back to the first available
 * outfits / a product with retailers so the section never renders empty.
 */
export async function getHomepageStylist(): Promise<HomepageStylist> {
  const ids = await getHomepageStylistIds();

  // Chat looks: resolve configured outfits in order, then top up from the
  // catalogue so there are always two cards in the preview.
  const allOutfits = await getAllOutfits();
  const chosen: Outfit[] = ids.chatOutfits
    .map((id) => allOutfits.find((o) => o.id === id))
    .filter((o): o is Outfit => Boolean(o));
  for (const o of allOutfits) {
    if (chosen.length >= MAX_CHAT_LOOKS) break;
    if (!chosen.some((c) => c.id === o.id)) chosen.push(o);
  }
  const chatLooks: StylistChatLook[] = chosen.slice(0, MAX_CHAT_LOOKS).map((o) => ({
    id: o.id,
    name: o.name,
    imageUrl: o.imageUrl,
    price: o.totalPriceMin,
    currency: o.currency,
  }));

  // Featured product: the configured one (with retailers attached), else the
  // first product that actually has a "where to buy" list.
  let featuredProduct: Product | null = null;
  if (ids.featuredProduct) {
    featuredProduct = (await getProductById(ids.featuredProduct)) ?? null;
  }
  if (!featuredProduct) {
    const all = await getAllProducts(true);
    featuredProduct = all.find((p) => p.retailers?.length > 0) ?? all[0] ?? null;
  }

  const retailerLogos = await getBrandLogos();

  // Extra stores the admin added on top of the item's own retailers. Only the
  // supported (integrated) stores are kept; each resolves its logo from the
  // store favicon and its link from the store homepage.
  const showcaseStores: ShowcaseStore[] = ids.extraStores
    .map((e) => ({ e, store: findSupportedStore(e.name) }))
    .filter((x): x is { e: ExtraStore; store: SupportedStore } => Boolean(x.store))
    .map(({ e, store }) => ({
      name: store.name,
      logoUrl: storeFaviconUrl(store.domain),
      price: e.price,
      url: storeHomepageUrl(store.domain),
    }));

  return { chatLooks, featuredProduct, retailerLogos, showcaseStores };
}
