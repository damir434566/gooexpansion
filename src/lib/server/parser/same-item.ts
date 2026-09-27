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
 * reduced (`piece-name.ts`), the colour the one card of that piece it fits,
 * the store a different one, and the two prices within a factor of three of
 * each other.
 *
 * The merge itself only ever FILLS: a field the existing row has is left alone.
 * Two stores describe the same coat differently, and the row that arrived first
 * is the one an admin may already have edited.
 */
import type { Retailer } from "@/lib/types";
import { colourRelation, samePiece } from "./piece-name";
import { brandsFit } from "./brand-from-name";

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

/** The answer to "which card is this page?", with the reason when there is none. */
export interface SameItemMatch {
  item: NamedItem | null;
  /** Set when `item` is null: why nothing fitted, in words the admin reads on the run's row. */
  miss?: string;
}

/** A card's colour as the admin would name it. */
const colourOf = (row: NamedItem) => (row.colors ?? []).filter(Boolean).join("/") || "no colour";

/**
 * The existing row this page is another store's listing of, by name — or none,
 * and why.
 *
 * Asked only after the codes found nothing. Among rows of the same brand it
 * takes the same piece (`samePiece`), sold somewhere else, at a comparable
 * price, and then decides by colour among that piece's cards:
 *
 *   - the same colour word wins outright;
 *   - the same colours in other words ("Core Black" beside "Black"), and then
 *     some of the card's colours ("Grey" beside "grey/white/leather": stores
 *     often name only the main one), count when exactly one card fits — a
 *     piece made in navy and in sky blue has two cards that are "blue";
 *   - a colour the page does not state — none at all, or only the photo's
 *     reading — takes the piece's one card when it has only one;
 *   - a colour neither of those finds is another colourway, which is left to
 *     the colour grouping.
 *
 * A card already carrying this store is another listing of the store's own, not
 * a second place to buy — unless it carries this very page, which is a
 * re-collect updating its price.
 *
 * Before the partial and unstated cases counted, a reseller's "Grey" Emerson
 * matched nothing, became its own card, and the colour grouping then filed it
 * beside etnies' "grey/white/leather" as a second colour of the same shoe.
 */
export function pickSameItemByName(
  incoming: {
    brand: string;
    name: string;
    colors: string[];
    /** False when `colors` are a reading of the photo, not the page's word. */
    coloursStated?: boolean;
    category?: string | null;
    /** Dollars, like `priceMin` on the rows. */
    price: number;
    sourceUrl: string | null;
  },
  rows: NamedItem[],
): SameItemMatch {
  const ourHost = hostOf(incoming.sourceUrl);
  // Without an address there is no place to buy to add.
  if (!ourHost) return { item: null, miss: "no address to add as a store" };

  const pieces: NamedItem[] = [];
  for (const row of rows) {
    if (row.sourceUrl && row.sourceUrl === incoming.sourceUrl) continue;
    // One maker under both stores' spellings ("adidas" / "adidas Originals"),
    // or a card saved without a brand whose name spells this one's.
    if (!brandsFit(row, incoming)) continue;
    const brands = [incoming.brand, row.brand ?? ""].filter((b) => b.trim());
    if (!samePiece(brands, incoming, row)) continue;
    if ((row.retailers ?? []).some((r) => r.url && r.url === incoming.sourceUrl)) return { item: row };
    pieces.push(row);
  }
  if (!pieces.length) {
    return { item: null, miss: incoming.brand.trim() ? "no card of this model" : "no brand on the page, and no card whose name matches" };
  }

  const elsewhere = pieces.filter(
    (row) => ![row.sourceUrl, ...(row.retailers ?? []).map((r) => r.url)].map(hostOf).includes(ourHost),
  );
  if (!elsewhere.length) return { item: null, miss: `this store is already on "${pieces[0].name}"` };

  const priced = elsewhere.filter((row) => {
    const theirs = typeof row.priceMin === "number" ? row.priceMin : 0;
    if (!(incoming.price > 0 && theirs > 0)) return true;
    return Math.max(incoming.price, theirs) / Math.min(incoming.price, theirs) <= MAX_PRICE_RATIO;
  });
  if (!priced.length) return { item: null, miss: `price is more than ${MAX_PRICE_RATIO}× away from "${elsewhere[0].name}"` };

  // The page names no colour of its own: the model's first card takes the
  // link. The store's page is the model's page, whichever colour it opens on,
  // and a link on the model is what the admin asked for — not a skip.
  const stated = incoming.coloursStated !== false && incoming.colors.length > 0;
  if (!stated) return { item: priced[0] };

  // Otherwise the closest colour wins, rather than a tie ending in nothing: the
  // same words first, then the same colours in other words, then some of them,
  // then a card that has no colour saved; among equals, the most colour words
  // in common. A colour none of these reaches is another colourway, which is
  // a card of its own.
  const RANK: Record<string, number> = { same: 4, near: 3, partial: 2, unknown: 1, none: 1 };
  const words = (list?: string[] | null) =>
    new Set((list ?? []).join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const ours = words(incoming.colors);
  const scored = priced
    .map((row, index) => {
      const rank = RANK[colourRelation(incoming.colors, row.colors)] ?? 0;
      const theirs = words(row.colors);
      const shared = [...ours].filter((w) => theirs.has(w)).length;
      return { row, rank, shared, index };
    })
    .filter((c) => c.rank > 0)
    .sort((a, b) => b.rank - a.rank || b.shared - a.shared || a.index - b.index);
  if (scored.length) return { item: scored[0].row };

  return { item: null, miss: `in the catalogue only in ${priced.map(colourOf).join(", ")}` };
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
 * is filled only where the existing row is empty — unless `linksOnly`, when the
 * store and its price are all the page adds: the admin collecting a second
 * store for its links has said the card is finished.
 */
export function mergePatch(
  row: ExistingItem,
  incoming: IncomingItem,
  opts: { linksOnly?: boolean } = {},
): MergeResult {
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
  if (opts.linksOnly) return { patch, filled };

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
