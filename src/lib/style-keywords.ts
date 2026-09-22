/**
 * The style vocabulary, in one place.
 *
 * This list was copied into four files — the profile, the admin product editor,
 * the admin outfit editor and the bulk-edit validator — and they happened to
 * agree. They would not have kept agreeing: the moment one gains a style the
 * others don't, a picker offers a tag the API rejects, and the shopper sees a
 * save fail for a reason nothing on screen explains.
 *
 * `satisfies` is what makes this the single source rather than merely the fifth
 * copy: the list cannot drift from the `StyleKeyword` union without failing to
 * compile.
 */
import type { StyleKeyword } from "@/lib/types";

export const STYLE_KEYWORDS = [
  "minimal",
  "streetwear",
  "classic",
  "avant-garde",
  "romantic",
  "utilitarian",
  "bohemian",
  "preppy",
  "sporty",
  "dark",
  "maximalist",
  "coastal",
  "academic",
] as const satisfies readonly StyleKeyword[];

/** Mutable copy, for the many `.map()` call sites that expect a plain array. */
export const STYLE_KEYWORD_LIST: StyleKeyword[] = [...STYLE_KEYWORDS];

/** True when `value` is a style this catalogue knows. Use before writing one. */
export function isStyleKeyword(value: unknown): value is StyleKeyword {
  return typeof value === "string" && (STYLE_KEYWORDS as readonly string[]).includes(value);
}

/**
 * The styles in `values` that this catalogue knows, deduplicated and in the
 * vocabulary's own order — so two looks tagged the same way read the same way,
 * whatever order they were clicked in.
 */
export function normalizeStyleKeywords(values: unknown): StyleKeyword[] {
  const list = Array.isArray(values) ? values : String(values ?? "").split(",");
  const wanted = new Set(list.map((v) => String(v).trim()).filter(Boolean));
  return STYLE_KEYWORD_LIST.filter((k) => wanted.has(k));
}

// ── Reading a style off a product ─────────────────────────────────────────────
// The importer wrote `styleKeywords: []` for every product it has ever created:
// the vocabulary above existed, the pickers used it, and nothing ever filled it
// from a page. The stylist reads these tags, so an empty column means a
// catalogue the stylist cannot reason about beyond category and colour.
//
// The rules below are the same shape as the category classifier's: ordered
// pairs of a pattern and the value it implies, matched against the words a page
// already gives us — the product's name, its description, its material and the
// label the tree filed it under.
//
// Deliberately narrow. A style tag is a soft signal (a filter, a hint to the
// stylist), so a missing one costs little and a wrong one teaches the stylist
// something false about the piece. Words that name a garment rather than a
// manner — "jacket", "dress" — are not here at all, and neither are colours:
// black is not a style, and inferring "dark" from it would tag half the
// catalogue.

const STYLE_RULES: [RegExp, StyleKeyword][] = [
  [/\bavant[-\s]?garde|deconstructed|asymmetric(?:al)?|sculptural|conceptual\b/i, "avant-garde"],
  [/\bstreetwear|street\s?style|skate|graffiti|graphic\s?(?:tee|print)|hype\b/i, "streetwear"],
  [/\butility|utilitarian|workwear|military|combat|tactical|technical|multi[-\s]?pocket\b/i, "utilitarian"],
  [/\bbohemian|\bboho\b|crochet|fringe[ds]?|paisley|kaftan|caftan|peasant\b/i, "bohemian"],
  [/\bpreppy|varsity|collegiate|argyle|letterman|pinstripe\b/i, "preppy"],
  [/\bacademic|academia|tweed|houndstooth|herringbone|corduroy|scholar\b/i, "academic"],
  [/\bsport|sports|sporty|athletic|performance|running|training|track\s?(?:suit|top|pant)|activewear|gym\b/i, "sporty"],
  [/\bcoastal|nautical|resort|seersucker|beachwear|vacation|holiday\s?shop|\blinen\b/i, "coastal"],
  [/\bromantic|feminine|floral|lace|ruffle[ds]?|bow\s?detail|chiffon|broderie\b/i, "romantic"],
  [/\bmaximalis[mt]|eclectic|statement\s?(?:piece|print)|sequin|leopard|animal\s?print|vibrant\b/i, "maximalist"],
  [/\bgothic|grunge|punk|darkwear|distressed\b/i, "dark"],
  [/\bclassic|timeless|heritage|tailor(?:ed|ing)|refined|elegant|trench|loafer\b/i, "classic"],
  [/\bminimal(?:ist)?|understated|clean\s?line|essential|pared[-\s]?back|sleek\b/i, "minimal"],
];

/**
 * The styles a product's own words imply, at most `max` of them.
 *
 * Returned in the vocabulary's order rather than the order they were found, so
 * two products tagged with the same pair read the same way — the same rule
 * `normalizeStyleKeywords` follows.
 */
export function inferStyleKeywords(text: string, max = 3): StyleKeyword[] {
  const source = (text ?? "").replace(/\s+/g, " ");
  if (source.length < 3) return [];

  const found = new Set<StyleKeyword>();
  for (const [pattern, style] of STYLE_RULES) {
    if (pattern.test(source)) found.add(style);
  }
  if (!found.size) return [];

  return STYLE_KEYWORD_LIST.filter((k) => found.has(k)).slice(0, max);
}
