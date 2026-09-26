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
 *   instead of links. Here the judgement has to be conservative, because the
 *   cost of a wrong answer is not a missing swatch — it is two different coats
 *   shown to a shopper as one coat in two colours.
 *
 * So the name test below insists on the same piece by `samePiece` — the name
 * with brand, colour and filler removed, matched exactly, never by prefix.
 * "Wool Coat" and "Wool Coat Long" share a prefix and are two products.
 *
 * It also insists the colours differ. Two rows of the same piece in the same
 * colour are not variants of each other — they are the same thing twice, which
 * is a different problem with a different fix (the retailer list, see
 * `same-item.ts`).
 */
import { colourRelation, sameModelFamily, samePiece } from "./piece-name";

export { sameModelFamily };

export interface VariantCandidate {
  id: string;
  name: string;
  colors: string[];
  category?: string | null;
  variantGroupId?: string | null;
  isGroupPrimary?: boolean | null;
}

/** True when `candidate` is our piece in a different colour, by name alone. */
export function isColorSiblingByName(
  ours: { brand: string; name: string; colors: string[]; category?: string | null },
  candidate: VariantCandidate,
): boolean {
  if (!samePiece(ours.brand, ours, candidate)) return false;

  // An unknown colour on either side is not evidence of sameness, but it is not
  // evidence against it either: the piece is still the same piece, and a group
  // whose colours are half-known is better than no group at all. Two words for
  // one base colour ("Navy", "Sky Blue") are two colourways from one store.
  return colourRelation(ours.colors, candidate.colors) !== "same";
}

/**
 * The group these siblings already belong to, if any, and whether anyone has
 * claimed to be its primary.
 *
 * A group with two primaries renders twice in the catalogue, so a row only
 * claims it when nobody else has.
 */
export function chooseGroup(siblings: VariantCandidate[]): {
  groupId?: string;
  hasPrimary: boolean;
} {
  const groupId = siblings.find((s) => !!s.variantGroupId)?.variantGroupId ?? undefined;
  const hasPrimary = siblings.some(
    (s) => s.isGroupPrimary === true && (!groupId || s.variantGroupId === groupId),
  );
  return { groupId: groupId ?? undefined, hasPrimary };
}
