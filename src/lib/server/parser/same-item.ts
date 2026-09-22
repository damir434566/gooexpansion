/**
 * Recognising the same item on a second store's page.
 *
 * A collect run walks one store at a time, so the same coat collected from two
 * retailers used to become two products, each showing one place to buy it. What
 * the catalogue wanted was one product with two links — which is only safe when
 * the two pages can be shown to be the same ITEM, not merely similar ones.
 *
 * Codes decide it, and only two of the three are usable:
 *
 *   gtin       the item's own number. Same GTIN, same thing, whoever sells it.
 *   brand+mpn  the maker's part number within its brand.
 *   sku        the store's shelf label — two retailers use the same string for
 *              different things, so it is never matched across hosts.
 *
 * Names are not used at all. "Wool Blend Bomber Jacket" is what four brands call
 * four different jackets, and a wrong merge is worse than two rows: it puts a
 * link on a product that sends a shopper to something else, and it reads as
 * correct while doing it.
 *
 * The merge itself only ever FILLS: a field the existing row has is left alone.
 * Two stores describe the same coat differently, and the row that arrived first
 * is the one an admin may already have edited.
 */
import type { Retailer } from "@/lib/types";

/** The columns the importer needs to decide and to merge. */
export interface ExistingItem {
  id: string;
  brand?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  sourceUrl?: string | null;
  priceMin?: number | null;
  priceMax?: number | null;
  retailers?: Retailer[] | null;
  material?: string | null;
  description?: string | null;
  subcategory?: string | null;
  sizes?: string[] | null;
  colors?: string[] | null;
  images?: string[] | null;
  sku?: string | null;
}

export interface IncomingItem {
  brand: string;
  gtin?: string;
  mpn?: string;
  sku?: string;
  /** Price in the catalogue's currency, i.e. already converted to dollars. */
  price: number;
  retailer?: Retailer;
  material?: string;
  description?: string;
  subcategory?: string;
  sizes?: string[];
  colors?: string[];
  images?: string[];
}

/** True when `row` is the same item as `incoming`, by code. */
export function isSameItem(incoming: IncomingItem, row: ExistingItem): boolean {
  const gtin = (incoming.gtin ?? "").trim();
  if (gtin && (row.gtin ?? "").trim() === gtin) return true;

  const mpn = (incoming.mpn ?? "").trim().toLowerCase();
  if (mpn && (row.mpn ?? "").trim().toLowerCase() === mpn) {
    const ours = incoming.brand.trim().toLowerCase();
    const theirs = (row.brand ?? "").trim().toLowerCase();
    return !!ours && ours === theirs;
  }

  return false;
}

/**
 * The retailer list with this store's entry in it.
 *
 * Replaced rather than appended when the store is already there, by URL first
 * and by name second: re-collecting a product must update its price, not give it
 * the same shop twice.
 */
export function withRetailer(existing: Retailer[] | null | undefined, entry: Retailer): Retailer[] {
  const list = Array.isArray(existing) ? [...existing] : [];
  const index = list.findIndex(
    (r) =>
      (r.url && entry.url && r.url === entry.url) ||
      (r.name && entry.name && r.name.toLowerCase() === entry.name.toLowerCase()),
  );
  if (index >= 0) list[index] = entry;
  else list.push(entry);
  return list.slice(0, 20);
}

export interface MergeResult {
  /** Database columns to write on the existing row. */
  patch: Record<string, unknown>;
  /** Field names this merge filled in, for the admin's row in the run. */
  filled: string[];
}

/**
 * What to write on the existing row so it carries this store too.
 *
 * The price range widens to include the new store's price: a product sold at two
 * prices has both, and the lower one is what a shopper is shown. Everything else
 * is filled only where the existing row is empty.
 */
export function mergePatch(row: ExistingItem, incoming: IncomingItem): MergeResult {
  const patch: Record<string, unknown> = {};
  const filled: string[] = [];

  if (incoming.retailer) {
    patch.retailers = withRetailer(row.retailers, incoming.retailer);
    filled.push("retailer");
  }

  if (incoming.price > 0) {
    const currentMin = typeof row.priceMin === "number" && row.priceMin > 0 ? row.priceMin : Infinity;
    const currentMax = typeof row.priceMax === "number" ? row.priceMax : 0;
    const nextMin = Math.min(currentMin, incoming.price);
    const nextMax = Math.max(currentMax, incoming.price);
    if (nextMin !== currentMin) {
      patch.price_min = nextMin;
      filled.push("price");
    }
    if (nextMax !== currentMax) patch.price_max = nextMax;
  }

  const fillText = (column: string, current: unknown, value: string | undefined) => {
    if (!value) return;
    if (typeof current === "string" && current.trim()) return;
    patch[column] = value;
    filled.push(column);
  };

  fillText("material", row.material, incoming.material);
  fillText("description", row.description, incoming.description);
  fillText("subcategory", row.subcategory, incoming.subcategory);
  fillText("gtin", row.gtin, incoming.gtin);
  fillText("mpn", row.mpn, incoming.mpn);
  fillText("sku", row.sku, incoming.sku);

  const fillList = (column: string, current: unknown, value: string[] | undefined) => {
    if (!value?.length) return;
    if (Array.isArray(current) && current.length) return;
    patch[column] = value;
    filled.push(column);
  };

  fillList("sizes", row.sizes, incoming.sizes);
  fillList("colors", row.colors, incoming.colors);
  fillList("images", row.images, incoming.images);

  return { patch, filled };
}
