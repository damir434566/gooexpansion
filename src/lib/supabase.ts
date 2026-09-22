import { createClient } from "@supabase/supabase-js";
import type { ColorGroup } from "@/lib/types";

export type DbColorGroup = {
  id: number;
  name: string;
  hex_code: string;
  sort_order: number;
};

export function dbToColorGroup(row: DbColorGroup): ColorGroup {
  return {
    id: row.id,
    name: row.name,
    hexCode: row.hex_code,
    sortOrder: row.sort_order,
  };
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Ceiling on any single request to Supabase.
 *
 * `supabase-js` fetches with no timeout of its own, so a database that stops
 * answering — rather than refusing — leaves the caller waiting forever. During
 * `next build` that is fatal in a way that is very hard to read: several pages
 * are prerendered and read the catalogue, so the build simply stops, with no
 * error, until the platform gives up on it hours later.
 *
 * Bounding it here rather than at each call site is deliberate. A guard added
 * page by page covers the pages someone remembered; this covers every request
 * the app will ever make, including the ones added next month.
 *
 * Sixty seconds is chosen against the slowest legitimate request rather than
 * the typical one: catalogue reads finish in well under a second, but the same
 * client uploads mirrored product photos of up to 20 MB.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.SUPABASE_REQUEST_TIMEOUT_MS) || 60_000;

/**
 * `fetch` that cannot wait forever, preserving any signal the caller passed.
 * Exported so the bound can be exercised directly rather than inferred.
 */
export function boundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}

export const supabase = url && key
  ? createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: boundedFetch },
    })
  : null;
export const isSupabaseConfigured = !!(url && key);

export type DbOutfitItem = {
  product_id: string;
  role: "hero" | "secondary" | "accent";
  selected_color?: string;
};

export type DbOutfit = {
  id: string;
  name: string;
  description: string;
  occasion: string;
  image_url: string;
  items: DbOutfitItem[];
  total_price_min: number;
  total_price_max: number;
  currency: string;
  style_keywords: string[];
  is_ai_generated: boolean;
  is_saved: boolean;
  season: string;
  created_at: string;
  source?: string | null;
  is_homepage_featured?: boolean | null;
};

export type DbBlogPost = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  category: string;
  cover_image_url: string;
  read_time: string;
  author_name: string;
  meta_title: string | null;
  meta_description: string | null;
  og_image: string | null;
  is_published: boolean;
  published_at: string;
  created_at: string;
  updated_at: string;
};

export type DbImportJob = {
  id: string;
  url: string;
  status: "pending" | "processing" | "done" | "failed";
  error: string | null;
  result_product_id: string | null;
  created_at: string;
};

export type DbProduct = {
  id: string;
  name: string;
  brand: string;
  category: string;
  subcategory?: string | null;
  description: string;
  image_url: string;
  images: string[];
  colors: string[];
  color_images: Record<string, string[]> | null;
  sizes: string[];
  material: string;
  retailers: object[];
  price_min: number;
  price_max: number;
  currency: string;
  is_new: boolean;
  is_saved: boolean;
  style_keywords: string[];
  gender?: string;
  created_at: string;
  // Color-variant linking
  variant_group_id?: string | null;
  color_hex?: string | null;
  is_group_primary?: boolean | null;
  // Manual crop data
  crop_data?: { x: number; y: number; width: number; height: number; focalX: number; focalY: number } | null;
  // Base color group IDs for color filter (references color_groups.id)
  color_group_ids?: number[] | null;
  // Backdrop colour sampled from the photo's corners (migration 015)
  bg_color?: string | null;
  // What the store charged, before the importer converted it (migration 019)
  source_price?: number | null;
  source_currency?: string | null;
  fx_rate?: number | null;
  fx_date?: string | null;
  // Codes that identify the item rather than the listing (migration 020)
  gtin?: string | null;
  mpn?: string | null;
  sku?: string | null;
};
