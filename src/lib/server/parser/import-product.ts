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
import { colorToHex, colorGroupNamesFor, MAX_PRODUCT_IMAGES } from "@/lib/server/product-fields";
import { toUsd } from "@/lib/server/fx";
import { loadRetailerRules, resolveRetailer } from "@/lib/server/retailer-domains";
import { mirrorProductImages } from "@/lib/server/storage/product-images";
import { storeBackgroundColor } from "@/lib/server/bg-color";
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

/** The colour-filter ids a product's colour labels put it under. */
async function colorGroupIdsFor(colors: string[]): Promise<number[] | undefined> {
  const names = colorGroupNamesFor(colors);
  if (!names.length) return undefined;
  const byName = await loadColorGroups();
  if (!byName) return undefined;
  const ids = names
    .map((n) => byName.get(n.toLowerCase()))
    .filter((id): id is number => typeof id === "number");
  return ids.length ? [...new Set(ids)] : undefined;
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
  const gender: Gender | undefined = GENDERS.includes(p.gender as Gender)
    ? (p.gender as Gender)
    : undefined;

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
      priceNote = `${sourcePrice} ${sourceCurrency} → $${price}${converted.live ? "" : " (fallback rate)"}`;
    } else {
      // A currency with no rate is left exactly as the store stated it. It will
      // read wrong in a dollar filter, and that is the lesser wrong: relabelling
      // it as dollars would make it read wrong everywhere, silently.
      priceNote = `no rate for ${sourceCurrency} — price kept as ${sourcePrice} ${sourceCurrency}`;
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

  const colors = (Array.isArray(p.colors) ? p.colors : [])
    .map((c: unknown) => String(c).trim())
    .filter(Boolean)
    .slice(0, 10);
  const sizes = (Array.isArray(p.sizes) ? p.sizes : [])
    .map((s: unknown) => String(s).trim())
    .filter(Boolean)
    .slice(0, 40);

  const brand = String(p.brand ?? "").trim().slice(0, 80);

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

  const colorGroupIds = await colorGroupIdsFor(colors);

  const product: Partial<Product> = {
    name,
    brand: brand as Product["brand"],
    category,
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
    styleKeywords: [],
    retailers,
    ...(colors[0] ? { colorHex: colorToHex(colors[0]) } : {}),
    ...(colorGroupIds ? { colorGroupIds } : {}),
  };

  const dbRow = { ...productToDb(product), source_url: sourceUrl };

  // Written through `writeProductRow` so a database that has not run the
  // colour-filter migration drops that one column and still takes the product,
  // instead of every import failing on a column it has never heard of.
  const insert = (row: Record<string, unknown>) =>
    supabase!.from("products").insert(row).select("id").maybeSingle();

  let productId: string | null = null;
  let updated = false;
  try {
    let existingId: string | null = null;
    if (sourceUrl) {
      const { data: existing } = await supabase
        .from("products").select("id").eq("source_url", sourceUrl).maybeSingle();
      existingId = (existing as { id: string } | null)?.id ?? null;
    }

    if (existingId) {
      const id = existingId;
      // PostgREST reports failures in `error` rather than throwing, so an
      // unchecked update reads as success while writing nothing (the silent
      // failure pattern audit item Б1-3 called out on the billing ledger).
      const { data, error } = await writeProductRow<{ id: string }>(dbRow, (row) =>
        supabase!.from("products").update(row).eq("id", id).select("id").maybeSingle(),
      );
      if (error) throw new Error(error.message);
      productId = data?.id ?? id;
      updated = true;
    } else {
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
  };
}
