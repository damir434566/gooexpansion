/**
 * Recognising the same item on a second store's page.
 *
 * A collect run walks one store at a time, so the same coat collected from two
 * retailers used to become two products, each showing one place to buy it. What
 * the catalogue wanted was one product with two links — which is only safe when
 * the two pages can be shown to be the same ITEM, not merely similar ones.
 *
 * Codes decide it first, and only two of the three are usable:
 *
 *   gtin       the item's own number. Same GTIN, same thing, whoever sells it.
 *   brand+mpn  the maker's part number within its brand.
 *   sku        the store's shelf label — two retailers use the same string for
 *              different things, so it is never matched across hosts.
 *
 * Most stores print none of them, so a page with no code is then asked by name
 * (`pickSameItemByName`) — under every condition that keeps a name from being
 * a guess. "Wool Blend Bomber Jacket" is what four brands call four different
 * jackets, and a wrong merge is worse than two rows: it puts a link on a
 * product that sends a shopper to something else, and it reads as correct
 * while doing it. So the brand must be the same, the piece the same once
 * reduced (`piece-name.ts`), the colour the same, the store a different one,
 * and the two prices within a factor of three of each other.
 *
 * The merge itself only ever FILLS: a field the existing row has is left alone.
 * Two stores describe the same coat differently, and the row that arrived first
 * is the one an admin may already have edited.
 */
import type { Retailer } from "@/lib/types";
import { colourRelation, samePiece } from "./piece-name";
import { foldBrand } from "./brand-from-name";

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

/** A row as the name test needs it: the merge columns plus what identifies the piece. */
export interface NamedItem extends ExistingItem {
  name: string;
  category?: string | null;
}

/**
 * Widest gap between two stores' prices for one item. A sale takes a price to
 * half and sometimes to a third; past that, two rows under one name are two
 * different things — a £90 cap and a £900 coat both called "Logo".
 */
const MAX_PRICE_RATIO = 3;

function hostOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "").toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * The existing row this page is another store's listing of, by name — or null.
 *
 * Asked only after the codes found nothing. Among rows of the same brand it
 * takes the one that is the same piece (`samePiece`) in the same colour, sold
 * somewhere else, at a comparable price:
 *
 *   - the same colour word wins outright; two words for one base colour
 *     ("Core Black" beside "Black") count only when exactly one row qualifies,
 *     since a piece made in navy and in sky blue has two rows that are "blue";
 *   - a colour stated on one side and not the other decides nothing, and is
 *     left to the colour grouping;
 *   - a row already carrying this store is another listing of the store's own,
 *     not a second place to buy — unless it carries this very page, which is a
 *     re-collect updating its price.
 */
export function pickSameItemByName(
  incoming: {
    brand: string;
    name: string;
    colors: string[];
    category?: string | null;
    /** Dollars, like `priceMin` on the rows. */
    price: number;
    sourceUrl: string | null;
  },
  rows: NamedItem[],
): NamedItem | null {
  const ourHost = hostOf(incoming.sourceUrl);
  // Without an address there is no place to buy to add.
  if (!ourHost || !incoming.brand.trim()) return null;

  const exact: NamedItem[] = [];
  const near: NamedItem[] = [];
  const brand = foldBrand(incoming.brand);
  for (const row of rows) {
    if (row.sourceUrl && row.sourceUrl === incoming.sourceUrl) continue;
    // The caller reads one brand's rows, but the decision does not lean on it.
    if (foldBrand(row.brand ?? "") !== brand) continue;
    if (!samePiece(incoming.brand, incoming, row)) continue;

    const relation = colourRelation(incoming.colors, row.colors);
    if (relation === "different" || relation === "unknown") continue;

    const retailers = row.retailers ?? [];
    if (retailers.some((r) => r.url && r.url === incoming.sourceUrl)) return row;
    const hosts = [row.sourceUrl, ...retailers.map((r) => r.url)].map(hostOf);
    if (hosts.includes(ourHost)) continue;

    const theirs = typeof row.priceMin === "number" ? row.priceMin : 0;
    if (incoming.price > 0 && theirs > 0) {
      const ratio = Math.max(incoming.price, theirs) / Math.min(incoming.price, theirs);
      if (ratio > MAX_PRICE_RATIO) continue;
    }

    (relation === "near" ? near : exact).push(row);
  }
  return exact[0] ?? (near.length === 1 ? near[0] : null);
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
