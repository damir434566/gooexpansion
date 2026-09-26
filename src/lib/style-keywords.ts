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

// Reading a style off a product's own words lives in `lib/taxonomy/styles`,
// next to the other dictionaries the importer reads pages with.
