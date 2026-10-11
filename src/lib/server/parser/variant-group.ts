/**
 * Deciding whether two rows are the same piece in another colour.
 *
 * The catalogue already knows how to show colour variants: rows sharing a
 * `variant_group_id` collapse into one card with a swatch row, and the CSV
 * importer forms those groups inside a batch. What had no answer was the URL
 * importer — a store collected one page at a time, so every colourway arrived
 * as its own product and the swatch row stayed empty.
 *
 * Two signals, and they are not equal:
 *
 *   The page's own links.  A colour row is usually a row of links, one per
 *   colourway, so the page states outright which addresses are the same piece.
 *   An address either matches a row we have or it does not; there is nothing to
 *   judge, and this is the signal to trust.
 *
 *   Brand and name.  What is left when the store switches colours with script
 *   instead of links — and the only signal across stores, since a colour row
 *   links that store's own pages and never another site's. So it is asked on
 *   every import, beside the links. Here the judgement has to be
 *   conservative, because the cost of a wrong answer is not a missing swatch —
 *   it is two different coats shown to a shopper as one coat in two colours.
 *
 * So the name test below insists on the same piece by `samePiece` — the name
 * with brand, colour and filler removed, matched exactly, never by prefix.
 * "Wool Coat" and "Wool Coat Long" share a prefix and are two products.
 *
 * The brand is the maker, however each store spells it: "adidas" on adidas.com
 * is "adidas Originals" on a reseller, "Carhartt" is "Carhartt WIP", a card
 * saved before its brand was read has none. The name test used to take our
 * spelling only, and the importer read only the cards filed under exactly that
 * spelling — so one jacket collected from two sites stayed two cards.
 *
 * Two rows of the same piece in the same colour are the same thing twice, and
 * the first fix for that is the retailer list (`same-item.ts`): the importer
 * merges such a page into the card before it ever makes one. What the merge
 * leaves — a colour field that is a reading of the photo, a price too far off
 * where one side names no brand — the importer still groups, in any colour
 * (`isSamePieceByName`); the Duplicates screen's colourway test still insists
 * the colours differ (`isColorSiblingByName`), and proposes the rest as merges.
 * The price never enters either: one colourway of a piece often costs more
 * than another.
 */
import { colourRelation, sameModelFamily, samePiece, variantsDiffer } from "./piece-name";
import { brandsFit, realBrand } from "./brand-from-name";

export { sameModelFamily };

export interface VariantCandidate {
  id: string;
  name: string;
  /** The card's brand as saved; a card without one is judged by its name. */
  brand?: string | null;
  colors: string[];
  category?: string | null;
  variantGroupId?: string | null;
  isGroupPrimary?: boolean | null;
}

/**
 * True when `candidate` is our piece, by name alone — in any colour, at any
 * price.
 *
 * What the importer groups by. A new card is made only when the page is not
 * another store's listing of a card we have (`pickSameItemByName`), and that
 * leaves cards of one model that the colour test below kept apart: two
 * colourways whose page states no colour, both read off their white photos as
 * "White"; one listing that missed the merge on price, where a side names no
 * brand. Each stood as its own card beside its own model. One model is one
 * card on the storefront, whatever its swatches say.
 */
export function isSamePieceByName(
  ours: { brand: string; name: string; colors: string[]; category?: string | null },
  candidate: VariantCandidate,
): boolean {
  // One maker under either spelling, or one side with no brand whose name
  // spells the other's (`brandsFit`). Where neither vouches — one side names
  // no brand at all — only a name that is a model on its own will do, as in
  // `pickSameItemByName`. A card saved with a store's sales copy for its brand
  // ("Wides Available") names none: it stood apart from its own colourways as
  // another maker's piece.
  const fit = brandsFit(ours, candidate);
  const oneUnbranded = !realBrand(ours.brand) !== !realBrand(candidate.brand);
  if (!fit && !oneUnbranded) return false;
  const brands = [realBrand(ours.brand), realBrand(candidate.brand)].filter(Boolean);
  return samePiece(brands, ours, candidate, { strict: !fit });
}

/**
 * True when `candidate` is our piece in a different colour, by name alone.
 *
 * The Duplicates screen's colourway test: the same piece in the same colour is
 * proposed there as one card to merge, not as a colour group.
 */
export function isColorSiblingByName(
  ours: { brand: string; name: string; colors: string[]; category?: string | null },
  candidate: VariantCandidate,
): boolean {
  if (!isSamePieceByName(ours, candidate)) return false;

  // Two names that each state a variant, and different ones — "(Black/White)"
  // and "(Grey/Black)" — are two colourways, whatever the colour fields read
  // off the photos.
  if (variantsDiffer(ours.name, candidate.name)) return true;

  // An unknown colour on either side is not evidence of sameness, but it is not
  // evidence against it either: the piece is still the same piece, and a group
  // whose colours are half-known is better than no group at all. Two words for
  // one base colour ("Navy", "Sky Blue") are two colourways from one store.
  return colourRelation(ours.colors, candidate.colors) !== "same";
}

/** A card as far as its colour group goes. */
export interface GroupedCard {
  id: string;
  variantGroupId?: string | null;
  isGroupPrimary?: boolean | null;
}

export interface GroupWrite {
  id: string;
  variant_group_id: string;
  is_group_primary: boolean;
}

/**
 * The writes that make these cards one colour group.
 *
 * `cards` is every card concerned: the ones found to be one piece, and every
 * other member of the groups they already belong to. A piece collected from
 * two stores used to end up in two groups — each store's colourways formed
 * their own — and a later import joined only the first group it met, so the
 * catalogue showed the piece twice. Every group the piece has becomes one: the
 * one that has a lead (then the largest) keeps its id and its lead, the others
 * join it. With no lead anywhere, `leadId` leads — a group with two leads
 * renders twice, so any other card claiming it gives it up.
 */
export function planColourGroup(
  cards: GroupedCard[],
  leadId: string,
  newGroupId: () => string,
): { groupId: string; writes: GroupWrite[] } {
  const sizes = new Map<string, number>();
  const led = new Set<string>();
  for (const c of cards) {
    if (!c.variantGroupId) continue;
    sizes.set(c.variantGroupId, (sizes.get(c.variantGroupId) ?? 0) + 1);
    if (c.isGroupPrimary) led.add(c.variantGroupId);
  }
  const groupId =
    [...sizes.keys()].sort((a, b) => Number(led.has(b)) - Number(led.has(a)) || sizes.get(b)! - sizes.get(a)!)[0] ??
    newGroupId();
  const primaryId = cards.find((c) => c.variantGroupId === groupId && c.isGroupPrimary)?.id ?? leadId;

  const writes: GroupWrite[] = [];
  const seen = new Set<string>();
  for (const c of cards) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const primary = c.id === primaryId;
    if (c.variantGroupId === groupId && !!c.isGroupPrimary === primary) continue;
    writes.push({ id: c.id, variant_group_id: groupId, is_group_primary: primary });
  }
  return { groupId, writes };
}
