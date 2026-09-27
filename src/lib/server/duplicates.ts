/**
 * Products the catalogue holds twice: the same item collected from two stores
 * before the importer could tell (or since, when a page carried too little to
 * be sure), sitting as two cards with one place to buy each.
 *
 * The test is the importer's own (`same-item.ts`, `piece-name.ts`), so the
 * finder proposes exactly what a collect run would have merged had it known:
 *
 *   by code   the same GTIN, or the same maker's part number within a brand;
 *   by name   the same brand, the same piece once reduced, the same colours in
 *             any order — or some of them ("Grey" beside "grey/white/leather"),
 *             or none stated where the store has one card of the piece — no
 *             store in common, and prices within a factor of four. Anything
 *             short of the same colour word counts only when a row has exactly
 *             one such candidate — a model made in two blacks is ambiguous,
 *             and a wrong merge sends a shopper to the other one.
 *
 * Pairs join into groups, and each group suggests the card to keep: the one on
 * the brand's own store, then the one with most stores, then the oldest. The
 * admin confirms every merge; nothing here writes.
 */
import type { Retailer } from "@/lib/types";
import { colourRelation, modelWord, sameModelFamily, samePiece } from "@/lib/server/parser/piece-name";
import { brandsAgree, foldBrand, makerKey, makerNames } from "@/lib/server/parser/brand-from-name";
import { isSameRetailer, MAX_PRICE_RATIO } from "@/lib/server/parser/same-item";

export interface CatalogueRow {
  id: string;
  brand: string;
  name: string;
  category: string | null;
  sourceUrl: string | null;
  priceMin: number | null;
  retailers: Retailer[];
  colors: string[];
  gtin?: string | null;
  mpn?: string | null;
  images: string[];
  createdAt: string | null;
}

export type DuplicateReason = "gtin" | "mpn" | "name";

export interface DuplicateGroup {
  /** The card the finder suggests keeping. */
  keepId: string;
  /** Every card in the group, the suggested keeper first. */
  ids: string[];
  /** Why each non-keeper is in the group, by id. */
  reasons: Record<string, DuplicateReason>;
}

function hostOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "").toLowerCase() : "";
  } catch {
    return "";
  }
}

/** Every store a card is bought from: its source page and its retailer links. */
export function storesOf(row: Pick<CatalogueRow, "sourceUrl" | "retailers">): Set<string> {
  return new Set([row.sourceUrl, ...(row.retailers ?? []).map((r) => r.url)].map(hostOf).filter(Boolean));
}

/** The order of preference among a group's cards: brand's own store, most stores, oldest. */
function keeperRank(a: CatalogueRow, b: CatalogueRow): number {
  const official = (r: CatalogueRow) => ((r.retailers ?? []).some((x) => x.isOfficial) ? 1 : 0);
  return (
    official(b) - official(a) ||
    (b.retailers?.length ?? 0) - (a.retailers?.length ?? 0) ||
    String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
    (b.images?.length ?? 0) - (a.images?.length ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

/** A dismissed pair, in one spelling whichever way round it is asked. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function findDuplicateGroups(rows: CatalogueRow[], dismissed: Set<string> = new Set()): DuplicateGroup[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const reasons = new Map<string, DuplicateReason>();
  const link = (a: string, b: string, why: DuplicateReason) => {
    if (a === b || dismissed.has(pairKey(a, b))) return;
    parent.set(find(a), find(b));
    // The strongest reason seen for each card: a code beats a name.
    for (const id of [a, b]) {
      const had = reasons.get(id);
      if (!had || (had === "name" && why !== "name")) reasons.set(id, why);
    }
  };
  for (const r of rows) parent.set(r.id, r.id);

  // ── By code ──
  const byGtin = new Map<string, string[]>();
  const byMpn = new Map<string, string[]>();
  for (const r of rows) {
    const gtin = (r.gtin ?? "").trim();
    if (gtin) byGtin.set(gtin, [...(byGtin.get(gtin) ?? []), r.id]);
    const mpn = (r.mpn ?? "").trim().toLowerCase();
    const brand = foldBrand(r.brand);
    if (mpn && brand) byMpn.set(`${brand}|${mpn}`, [...(byMpn.get(`${brand}|${mpn}`) ?? []), r.id]);
  }
  for (const ids of byGtin.values()) for (let i = 1; i < ids.length; i++) link(ids[0], ids[i], "gtin");
  for (const ids of byMpn.values()) for (let i = 1; i < ids.length; i++) link(ids[0], ids[i], "mpn");

  // ── By name ──
  // `samePiece` only ever says yes to two rows whose reduced names share their
  // core, so rows are compared within a brand-and-core bucket rather than every
  // row against every other one of its brand.
  const buckets = new Map<string, CatalogueRow[]>();
  for (const r of rows) {
    // By the maker and the model's own word, not the exact brand and name:
    // "adidas" / "adidas Originals", "Jordan" / "Nike" and "Toro Bravo" /
    // "Toro Bravo (2026)" are one piece, and an exact key put them in
    // different buckets. `samePiece` below still decides every pair.
    const brand = makerKey(r.brand);
    if (!brand) continue;
    const model = modelWord(r.name, makerNames(r.brand), r.colors);
    if (!model) continue;
    const key = `${brand}|${model}`;
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }

  // Ambiguity is a question about one store: if etnies lists the Emerson in
  // "black/gum" and in "black/black", a reseller's "Black" could be either, and
  // is linked to neither. Candidates are therefore sorted by the store they
  // come from, and a store offering exactly one is a partner. A pair is linked
  // only when each side picks the other — seen from one of etnies' two blacks,
  // the reseller's "Black" is the only candidate, and that alone would fold
  // two different colourways into one group.
  const primaryStore = (r: CatalogueRow) => hostOf(r.sourceUrl) || hostOf(r.retailers?.[0]?.url);
  const partners = new Map<string, Set<string>>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (const a of bucket) {
      const storesA = storesOf(a);
      if (!storesA.size) continue;
      type Slot = { exact: string[]; near: string[]; partial: string[]; unstated: string[]; all: string[] };
      const perStore = new Map<string, Slot>();
      for (const b of bucket) {
        if (a.id === b.id) continue;
        if (!brandsAgree(a.brand, b.brand)) continue;
        if (!samePiece([a.brand, b.brand], a, b)) continue;
        const storesB = storesOf(b);
        if (!storesB.size || [...storesB].some((s) => storesA.has(s))) continue;
        const pa = a.priceMin ?? 0;
        const pb = b.priceMin ?? 0;
        if (pa > 0 && pb > 0 && Math.max(pa, pb) / Math.min(pa, pb) > MAX_PRICE_RATIO) continue;
        const store = primaryStore(b);
        const slot = perStore.get(store) ?? { exact: [], near: [], partial: [], unstated: [], all: [] };
        const relation = colourRelation(a.colors, b.colors);
        if (relation === "same") slot.exact.push(b.id);
        else if (relation === "near") slot.near.push(b.id);
        else if (relation === "partial") slot.partial.push(b.id);
        else if (relation === "unknown" || relation === "none") slot.unstated.push(b.id);
        slot.all.push(b.id);
        perStore.set(store, slot);
      }
      // The importer's order (`pickSameItemByName`): the same colour, the same
      // colours in other words, some of the colours; and a card with no colour
      // on either side only when the store has one card of the piece at all.
      const chosen = new Set<string>();
      for (const { exact, near, partial, unstated, all } of perStore.values()) {
        const pick = exact.length ? exact : near.length ? near : partial;
        if (pick.length === 1) chosen.add(pick[0]);
        else if (!pick.length && all.length === 1 && (!a.colors.length || unstated.length === 1)) chosen.add(all[0]);
      }
      partners.set(a.id, chosen);
    }
  }
  for (const [a, chosen] of partners) {
    for (const b of chosen) if (partners.get(b)?.has(a)) link(a, b, "name");
  }

  // ── Groups ──
  const members = new Map<string, CatalogueRow[]>();
  for (const r of rows) {
    const root = find(r.id);
    members.set(root, [...(members.get(root) ?? []), r]);
  }
  const groups: DuplicateGroup[] = [];
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(keeperRank);
    const keepId = sorted[0].id;
    groups.push({
      keepId,
      ids: sorted.map((r) => r.id),
      reasons: Object.fromEntries(sorted.slice(1).map((r) => [r.id, reasons.get(r.id) ?? "name"])),
    });
  }
  // Biggest groups first, then by the keeper's name, so a re-run reads the same.
  return groups.sort(
    (a, b) => b.ids.length - a.ids.length || (byId.get(a.keepId)?.name ?? "").localeCompare(byId.get(b.keepId)?.name ?? ""),
  );
}

// ── Colour groups that hold more than one model ──────────────────────────────

export interface GroupMember {
  id: string;
  brand: string;
  name: string;
  category: string | null;
  colors: string[];
  variantGroupId: string;
  isGroupPrimary: boolean;
}

export interface MixedGroup {
  groupId: string;
  /** The models in the group, each a list of member ids; the suggested one to keep first. */
  families: string[][];
}

/** Members split into models: two members are one model when `sameModelFamily` says so. */
export function modelFamilies(members: GroupMember[]): string[][] {
  const parent = new Map(members.map((m) => [m.id, m.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i];
      const b = members[j];
      if (find(a.id) === find(b.id)) continue;
      if (sameModelFamily(a.brand || b.brand, a, b)) parent.set(find(a.id), find(b.id));
    }
  }
  const families = new Map<string, string[]>();
  for (const m of members) families.set(find(m.id), [...(families.get(find(m.id)) ?? []), m.id]);
  return [...families.values()];
}

/**
 * Colour groups whose members are more than one model — what a store's
 * "you may also like" rail made of them when it was read as the colour row.
 * The model to keep in the group is the one holding its primary card, else the
 * largest.
 */
export function findMixedColourGroups(members: GroupMember[]): MixedGroup[] {
  const byGroup = new Map<string, GroupMember[]>();
  for (const m of members) {
    if (!m.variantGroupId) continue;
    byGroup.set(m.variantGroupId, [...(byGroup.get(m.variantGroupId) ?? []), m]);
  }
  const out: MixedGroup[] = [];
  for (const [groupId, list] of byGroup) {
    if (list.length < 2) continue;
    const families = modelFamilies(list);
    if (families.length < 2) continue;
    const primary = list.find((m) => m.isGroupPrimary)?.id;
    families.sort((a, b) => Number(b.includes(primary ?? "")) - Number(a.includes(primary ?? "")) || b.length - a.length);
    out.push({ groupId, families });
  }
  return out.sort((a, b) => b.families.length - a.families.length);
}

/**
 * What to write when a mixed group is split: the kept model stays in the
 * group (with one primary), every other model of two or more cards becomes a
 * group of its own, and a lone card leaves grouping altogether.
 */
export function splitPlan(
  members: GroupMember[],
  keepIds: Set<string>,
  newGroupId: () => string,
): { id: string; variant_group_id: string | null; is_group_primary: boolean }[] {
  const kept = members.filter((m) => keepIds.has(m.id));
  const rest = members.filter((m) => !keepIds.has(m.id));
  const writes: { id: string; variant_group_id: string | null; is_group_primary: boolean }[] = [];

  const keptPrimary = kept.find((m) => m.isGroupPrimary) ?? kept[0];
  for (const m of kept) {
    if (kept.length < 2) writes.push({ id: m.id, variant_group_id: null, is_group_primary: false });
    else writes.push({ id: m.id, variant_group_id: m.variantGroupId, is_group_primary: m.id === keptPrimary?.id });
  }
  for (const family of modelFamilies(rest)) {
    const cards = rest.filter((m) => family.includes(m.id));
    if (cards.length < 2) {
      writes.push({ id: cards[0].id, variant_group_id: null, is_group_primary: false });
      continue;
    }
    const group = newGroupId();
    const primary = cards.find((m) => m.isGroupPrimary) ?? cards[0];
    for (const m of cards) writes.push({ id: m.id, variant_group_id: group, is_group_primary: m.id === primary.id });
  }
  return writes;
}

// ── Merging ──────────────────────────────────────────────────────────────────

type DbRow = Record<string, unknown>;

const TEXT_FILL = ["image_url", "material", "description", "subcategory", "gtin", "mpn", "sku", "gender"];
const LIST_FILL = ["sizes", "colors", "images", "style_keywords", "color_group_ids"];

const positive = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);

/**
 * What to write on the kept card so it carries the others.
 *
 * Every store of every card becomes one of its stores — a store it already has
 * keeps its own entry. The price range spans them all. Everything else is
 * filled only where the kept card is empty, because the kept card is the one
 * an admin chose and may already have edited. Only columns the kept row
 * actually has are written.
 */
export function mergeCardsPatch(keep: DbRow, others: DbRow[]): { patch: DbRow; filled: string[] } {
  const patch: DbRow = {};
  const filled = new Set<string>();

  const retailers: Retailer[] = Array.isArray(keep.retailers) ? [...(keep.retailers as Retailer[])] : [];
  for (const other of others) {
    for (const entry of Array.isArray(other.retailers) ? (other.retailers as Retailer[]) : []) {
      // The same store by address — never by name alone, or `nike.ua`'s link
      // was dropped from a card that had `nike.com`'s, both called "Nike".
      const known = retailers.some((r) => isSameRetailer(r, entry));
      if (!known && retailers.length < 20) {
        retailers.push(entry);
        filled.add("stores");
      }
    }
  }
  if (filled.has("stores")) patch.retailers = retailers;

  for (const [minCol, maxCol] of [["price_min", "price_max"], ["price_min_usd", "price_max_usd"]] as const) {
    if (!(minCol in keep)) continue;
    const mins = [keep, ...others].map((r) => positive(r[minCol]) ?? positive(r.price_min)).filter((v): v is number => v !== undefined);
    const maxes = [keep, ...others].map((r) => positive(r[maxCol]) ?? positive(r.price_max)).filter((v): v is number => v !== undefined);
    if (mins.length && Math.min(...mins) !== keep[minCol]) {
      patch[minCol] = Math.min(...mins);
      filled.add("price");
    }
    if (maxes.length && maxCol in keep && Math.max(...maxes) !== keep[maxCol]) patch[maxCol] = Math.max(...maxes);
  }

  for (const column of TEXT_FILL) {
    if (!(column in keep)) continue;
    const current = keep[column];
    if (typeof current === "string" && current.trim()) continue;
    const value = others.map((o) => o[column]).find((v) => typeof v === "string" && v.trim());
    if (value !== undefined) {
      patch[column] = value;
      filled.add(column);
    }
  }
  for (const column of LIST_FILL) {
    if (!(column in keep)) continue;
    const current = keep[column];
    if (Array.isArray(current) && current.length) continue;
    const value = others.map((o) => o[column]).find((v) => Array.isArray(v) && v.length);
    if (value !== undefined) {
      patch[column] = value;
      filled.add(column);
    }
  }

  return { patch, filled: [...filled] };
}

/** A list of look pieces or outfit items with one product id swapped for another. */
export function repointItems<T extends Record<string, unknown>>(
  items: T[],
  key: string,
  from: Set<string>,
  to: string,
): { items: T[]; changed: boolean } {
  let changed = false;
  const out = items.map((item) => {
    const id = item?.[key];
    if (typeof id === "string" && from.has(id)) {
      changed = true;
      return { ...item, [key]: to };
    }
    return item;
  });
  return { items: out, changed };
}
