/**
 * What the editor's own labelling says about a brand and a store — the part of
 * a product's style and gender that its page does not say.
 *
 * Style. A brand builds its catalogue around a manner: nearly everything VLONE
 * or Gallery Dept. makes is filed streetwear, and a black piece from a brand
 * that leans dark is usually filed dark. Words on the page mostly miss this —
 * measured on the live catalogue, keyword styles agreed with the editor 44% of
 * the time, below always answering "streetwear" (88%). So a style is proposed
 * from three signals, and each is used only as far as the catalogue shows it
 * works:
 *
 *   brand     the styles the editor gave most of this brand's pieces;
 *   words     the style dictionary, per style, only where its tags have agreed
 *             with the editor's often enough (sporty did at 87%, minimal at 6%);
 *   colour    a dark-toned piece is "dark" — overall, or only within brands the
 *             editor ever calls dark, whichever the catalogue bears out.
 *
 * Gender. A store's site says "Men" and "Women", or "All" and "Women", and what
 * "All" means is the brand's convention: men's at one, unisex at the next. The
 * convention is learned from what the editor chose for the pieces whose page
 * said nothing — per brand, then per store — after the admin's explicit store
 * setting (`retailer_domains.default_gender`), which beats both.
 *
 * Everything here is built from the catalogue as a pure function, so the mining
 * report can build it from one part of the catalogue and score it on another.
 */
import type { Gender, StyleKeyword } from "@/lib/types";
import { STYLE_KEYWORD_LIST, isStyleKeyword } from "@/lib/style-keywords";
import { inferStyleKeywords } from "@/lib/taxonomy/styles";
import { genderFromPage } from "@/lib/taxonomy/gender";
import { domainCandidates, domainFromUrl } from "@/lib/server/retailer-domains";
import { loadLabelledProducts, type LabelledProduct } from "@/lib/server/catalogue-labels";

// ── Thresholds ───────────────────────────────────────────────────────────────

/** A brand needs this many style-tagged pieces before its habits count. */
export const BRAND_MIN_PIECES = 3;
/** A style is the brand's when at least this share of its pieces carry it. */
export const BRAND_STYLE_SHARE = 0.6;
/** A signal is trusted when at least this share of its tags agreed with the editor… */
export const SIGNAL_MIN_PRECISION = 0.7;
/** …over at least this many tags. */
export const SIGNAL_MIN_TAGS = 5;
/** Below this many style-tagged products nothing can be calibrated: the words are used as they are. */
export const CALIBRATION_MIN_PRODUCTS = 50;
/** A brand "uses dark" when this share of its pieces are filed dark. */
export const DARK_BRAND_SHARE = 0.2;
/** A gender is a brand's or store's convention at this share of its silent pieces. */
export const GENDER_SHARE = 0.8;
export const BRAND_GENDER_MIN = 3;
export const STORE_GENDER_MIN = 5;
/** At most this many styles per piece; the editor averages about two. */
export const MAX_STYLES = 3;

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Tally {
  n: number;
  counts: Record<string, number>;
}

interface Agreement {
  tagged: number;
  right: number;
}

export interface CatalogueProfile {
  /** Products carrying at least one style tag. */
  styled: number;
  brandStyles: Map<string, Tally>;
  /** Gender the editor chose for pieces whose page stated none. */
  brandGender: Map<string, Tally>;
  storeGender: Map<string, Tally>;
  /** Per style: how often the dictionary's tag was the editor's too. */
  keywordStyles: Map<StyleKeyword, Agreement>;
  /** Dark-toned pieces called dark: over the catalogue, and within brands that use dark. */
  darkTone: { all: Agreement; inDarkBrands: Agreement };
}

export interface ProfileInput {
  brand: string;
  name: string;
  description: string;
  colors: string[];
  colorGroups: string[];
  sourceUrl: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Brands compared by their letters: "Gallery Dept." and "gallery dept" are one brand. */
export function brandKey(brand: string): string {
  return (brand ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const add = (map: Map<string, Tally>, key: string, value: string) => {
  if (!key) return;
  const t = map.get(key) ?? { n: 0, counts: {} };
  t.n++;
  t.counts[value] = (t.counts[value] ?? 0) + 1;
  map.set(key, t);
};

const share = (t: Tally | undefined, value: string) => (t && t.n ? (t.counts[value] ?? 0) / t.n : 0);

/** The value holding at least `min` of a tally, if any does. */
function dominant(t: Tally | undefined, minShare: number, minN: number): { value: string; share: number } | undefined {
  if (!t || t.n < minN) return undefined;
  let best: { value: string; share: number } | undefined;
  for (const [value, count] of Object.entries(t.counts)) {
    const s = count / t.n;
    if (s >= minShare && (!best || s > best.share)) best = { value, share: s };
  }
  return best;
}

const precise = (a: Agreement | undefined) =>
  !!a && a.tagged >= SIGNAL_MIN_TAGS && a.right / a.tagged >= SIGNAL_MIN_PRECISION;

/**
 * Words that make a colour a dark, sombre one. "Charcoal", "anthracite", "dark
 * navy", "washed black", "тёмно-серый".
 */
const DARK_WORDS =
  /\b(?:black|noir|dark|deep|charcoal|anthracite|anthra|graphite|onyx|jet|coal|ink|midnight|oxblood|obsidian|raven|soot)\b|ч[её]рн|чорн|т[её]мн|угольн|вугільн|графит|графіт|антрацит/i;
/** Groups that make a piece light whatever else it is: "Black/White" is not a dark piece. */
const LIGHT_GROUPS = new Set(["White", "Beige", "Yellow", "Pink", "Orange"]);

/** Is this piece dark-toned — black, or a dark shade, with nothing light in it? */
export function isDarkTone(colors: string[], colorGroups: string[]): boolean {
  if (colorGroups.some((g) => LIGHT_GROUPS.has(g))) return false;
  if (colorGroups.includes("Black")) return true;
  return colors.some((c) => DARK_WORDS.test(c ?? ""));
}

/** Where the piece was bought, as the store settings key it. */
export function storeKey(sourceUrl: string | null | undefined): string {
  return sourceUrl ? domainFromUrl(sourceUrl) : "";
}

/** Did the page itself say who the piece is for? */
function pageStatesGender(p: ProfileInput): boolean {
  return !!genderFromPage({ name: p.name, url: p.sourceUrl ?? undefined, description: p.description });
}

// ── Building ─────────────────────────────────────────────────────────────────

export function buildCatalogueProfile(rows: LabelledProduct[]): CatalogueProfile {
  const brandStyles = new Map<string, Tally>();
  const brandGender = new Map<string, Tally>();
  const storeGender = new Map<string, Tally>();
  const keywordStyles = new Map<StyleKeyword, Agreement>(STYLE_KEYWORD_LIST.map((s) => [s, { tagged: 0, right: 0 }]));
  let styled = 0;

  for (const r of rows) {
    const styles = r.styleKeywords.filter(isStyleKeyword);
    const brand = brandKey(r.brand);
    if (styles.length) {
      styled++;
      // A brand's piece counts once towards its total and once per style it carries.
      const t = brandStyles.get(brand) ?? { n: 0, counts: {} };
      t.n++;
      for (const s of styles) t.counts[s] = (t.counts[s] ?? 0) + 1;
      if (brand) brandStyles.set(brand, t);

      for (const s of inferStyleKeywords(`${r.name} ${r.description}`, STYLE_KEYWORD_LIST.length)) {
        const a = keywordStyles.get(s)!;
        a.tagged++;
        if (styles.includes(s)) a.right++;
      }
    }

    if (r.gender && !pageStatesGender(r)) {
      add(brandGender, brand, r.gender);
      add(storeGender, storeKey(r.sourceUrl), r.gender);
    }
  }

  // Dark tone, measured after the brand tallies exist: "within dark brands" needs them.
  const all: Agreement = { tagged: 0, right: 0 };
  const inDarkBrands: Agreement = { tagged: 0, right: 0 };
  for (const r of rows) {
    if (!r.styleKeywords.length || !isDarkTone(r.colors, r.colorGroups)) continue;
    const dark = r.styleKeywords.includes("dark");
    all.tagged++;
    if (dark) all.right++;
    if (share(brandStyles.get(brandKey(r.brand)), "dark") >= DARK_BRAND_SHARE) {
      inDarkBrands.tagged++;
      if (dark) inDarkBrands.right++;
    }
  }

  return { styled, brandStyles, brandGender, storeGender, keywordStyles, darkTone: { all, inDarkBrands } };
}

// ── Proposing ────────────────────────────────────────────────────────────────

export interface StyleProposal {
  styles: StyleKeyword[];
  /** One line per style kept, saying what argued for it. */
  reasons: string[];
}

/**
 * The styles to file a piece under.
 *
 * `keywordStyles` are what the style dictionary read off the page. They are
 * used only per style, where the catalogue shows that style's words agree with
 * the editor — and unfiltered only while there are too few tagged products to
 * tell.
 */
export function proposeStyles(
  piece: { brand: string; keywordStyles: StyleKeyword[]; colors: string[]; colorGroups: string[] },
  profile: CatalogueProfile,
): StyleProposal {
  const candidates = new Map<StyleKeyword, { confidence: number; reason: string }>();
  const offer = (style: StyleKeyword, confidence: number, reason: string) => {
    const had = candidates.get(style);
    if (!had || confidence > had.confidence) candidates.set(style, { confidence, reason });
  };
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  const brandTally = profile.brandStyles.get(brandKey(piece.brand));
  if (brandTally && brandTally.n >= BRAND_MIN_PIECES) {
    for (const [style, count] of Object.entries(brandTally.counts)) {
      const s = count / brandTally.n;
      if (s >= BRAND_STYLE_SHARE && isStyleKeyword(style)) {
        offer(style, s, `${style}: ${pct(s)} of ${piece.brand}'s ${brandTally.n} pieces`);
      }
    }
  }

  const calibrated = profile.styled >= CALIBRATION_MIN_PRODUCTS;
  for (const style of piece.keywordStyles) {
    if (!calibrated) {
      offer(style, 0.5, `${style}: from the page's words`);
      continue;
    }
    const a = profile.keywordStyles.get(style);
    if (precise(a)) offer(style, a!.right / a!.tagged, `${style}: from the page's words (right ${pct(a!.right / a!.tagged)} of the time)`);
  }

  if (isDarkTone(piece.colors, piece.colorGroups)) {
    const { all, inDarkBrands } = profile.darkTone;
    if (precise(all)) {
      offer("dark", all.right / all.tagged, `dark: a dark-toned piece (${pct(all.right / all.tagged)} of them are)`);
    } else if (precise(inDarkBrands) && share(brandTally, "dark") >= DARK_BRAND_SHARE) {
      offer("dark", inDarkBrands.right / inDarkBrands.tagged,
        `dark: a dark-toned piece from a brand that uses dark (${pct(inDarkBrands.right / inDarkBrands.tagged)} of them are)`);
    }
  }

  const kept = [...candidates.entries()]
    .sort((a, b) => b[1].confidence - a[1].confidence)
    .slice(0, MAX_STYLES);
  const keptStyles = new Set(kept.map(([s]) => s));
  return {
    styles: STYLE_KEYWORD_LIST.filter((s) => keptStyles.has(s)),
    reasons: kept.map(([, c]) => c.reason),
  };
}

export interface GenderProposal {
  gender: Gender;
  /** Which of the three decided it. */
  source: "store-setting" | "brand" | "store";
  reason: string;
}

const GENDERS: readonly string[] = ["women", "men", "unisex"];

/**
 * Who a piece is for when its page does not say: the admin's setting for the
 * store, then the brand's habit, then the store's habit. Undefined when none of
 * them is settled enough to trust — an empty gender is honest, a guessed one
 * files the piece where shoppers of the other gender never see it.
 */
export function proposeGender(
  piece: { brand: string; sourceUrl: string | null; storeDefault?: Gender },
  profile: CatalogueProfile,
): GenderProposal | undefined {
  if (piece.storeDefault) return { gender: piece.storeDefault, source: "store-setting", reason: "the store's setting" };

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const brand = dominant(profile.brandGender.get(brandKey(piece.brand)), GENDER_SHARE, BRAND_GENDER_MIN);
  if (brand && GENDERS.includes(brand.value)) {
    const n = profile.brandGender.get(brandKey(piece.brand))!.n;
    return { gender: brand.value as Gender, source: "brand", reason: `${pct(brand.share)} of ${piece.brand}'s ${n} unmarked pieces` };
  }

  for (const candidate of domainCandidates(storeKey(piece.sourceUrl))) {
    const tally = profile.storeGender.get(candidate);
    const store = dominant(tally, GENDER_SHARE, STORE_GENDER_MIN);
    if (store && GENDERS.includes(store.value)) {
      return { gender: store.value as Gender, source: "store", reason: `${pct(store.share)} of ${candidate}'s ${tally!.n} unmarked pieces` };
    }
  }
  return undefined;
}

// ── Loading ──────────────────────────────────────────────────────────────────

/**
 * Reused for ten minutes. A crawl imports hundreds of pages in a row and must
 * not re-read the catalogue for each; the editor's tagging changes slowly, and
 * a profile ten minutes old is as good as a fresh one.
 */
const CACHE_TTL_MS = 10 * 60_000;
let cache: { profile: CatalogueProfile; at: number } | null = null;

const EMPTY: CatalogueProfile = buildCatalogueProfile([]);

/** The live catalogue's profile. Never throws: a catalogue it cannot read is an empty one. */
export async function loadCatalogueProfile(): Promise<CatalogueProfile> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.profile;
  try {
    const rows = await loadLabelledProducts(false);
    const profile = "error" in rows ? EMPTY : buildCatalogueProfile(rows);
    cache = { profile, at: Date.now() };
    return profile;
  } catch {
    return EMPTY;
  }
}
