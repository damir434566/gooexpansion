/**
 * Shared, pure field-normalisation helpers for product ingestion.
 *
 * These are used by BOTH the CSV affiliate-feed importer
 * (`/api/admin/csv-import`) and the universal URL parser
 * (`/api/admin/parser/*`). Keep them dependency-free and side-effect-free so
 * they can run in any serverless route.
 */
import { garmentCategory } from "@/lib/taxonomy/garments";
import {
  COLOUR_PHRASES,
  COLOUR_STEMS,
  FIELD_COLOUR_STEMS,
  FIELD_COLOUR_WORDS,
  MULTICOLOUR_WORDS,
  QUALIFIER_COLOUR_STEMS,
  QUALIFIER_COLOUR_WORDS,
  SAFE_COLOUR_WORDS,
} from "@/lib/taxonomy/colours";
import type { Category, Gender } from "@/lib/types";

// ── Strip trailing size suffix from a product name ────────────────────────────
// Affiliate names often look like "Polo Shirt - Blue - M" → strip " - M".

const SIZE_SUFFIXES =
  /\s+-\s+(one\s*size|one|os|xxs|xs|s|m|l|xl|xxl|2xl|3xl|4xl|\d{1,3}(?:\.\d)?)$/i;

export function cleanName(raw: string): string {
  return (raw ?? "").replace(SIZE_SUFFIXES, "").trim();
}

// ── Strip the store's furniture from a product name ───────────────────────────
//
// A page title is written for a search engine, not for a catalogue:
//
//     "Куртка бомбер, чёрная — MyStore | Купить с доставкой"
//
// Only the first few words are the product. The rest is the shop's name and its
// sales copy, repeated on every page it owns, and it used to land in the
// catalogue verbatim because the name came from `og:title` and `cleanName` only
// ever removed a trailing size.

/**
 * Separators a store hangs its own name off. Captured, so a split keeps them
 * and a name loses only the segments that were removed.
 */
const TITLE_SPLIT = /(\s+[|—–·•]\s+|\s+-\s+)/;

/**
 * Sales words that are never part of a garment's name. Matched only as whole
 * trailing or leading segments, so a "Sale Rail Tote" keeps its name.
 */
const BOILERPLATE =
  /^(?:buy(?:\s+online)?|shop(?:\s+online)?|online(?:\s+(?:store|shop))?|official(?:\s+(?:site|store))?|free\s+shipping|fast\s+delivery|sale|discounts?|price|best\s+price|new\s+arrivals?|купить(?:\s+\S+)*|цена|доставка|интернет-магазин|магазин|заказать|недорого)$/i;

function slug(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9а-яё]/gi, "");
}

/**
 * The words a host could be called by, so "shop.mystore.co.uk" is recognised as
 * MyStore rather than as "shop".
 *
 * Every label is a candidate because the shop's name can sit anywhere in the
 * host, but the generic ones are dropped: a title segment reading exactly "shop"
 * or "uk" says nothing about which store this is, and removing it on that basis
 * would eat real words.
 */
const HOST_NOISE = new Set([
  "www", "shop", "store", "sklep", "magazin", "com", "net", "org", "co", "uk",
  "ua", "pl", "de", "fr", "it", "es", "cz", "eu", "us", "io", "online", "site",
]);

function hostWords(host: string): string[] {
  return (host ?? "")
    .toLowerCase()
    .split(".")
    .map(slug)
    .filter((w) => w.length >= 3 && !HOST_NOISE.has(w));
}

export interface TidyNameOptions {
  /** The store's hostname, so a title ending in the shop's own name loses it. */
  host?: string;
  /** The product's brand, so "Aurelio Aurelio Nebula Jacket" says it once. */
  brand?: string;
  /**
   * A trailing string observed on every title across this store. Whatever is
   * identical on twenty different products is not any one product's name, and
   * no list of stop-words can be as reliable about a given shop as the shop's
   * own repetition. Supplied by the caller that can see more than one page.
   */
  titleSuffix?: string;
}

/**
 * Turn a page title into a product name.
 *
 * Deliberately conservative: it only removes a trailing segment it can justify
 * — one the whole store repeats, one that is the shop's own name or host, or
 * one that is pure sales copy. A name it cannot explain is left alone, because
 * a slightly long name is a much smaller problem than a truncated one.
 */
export function tidyProductName(raw: string, opts: TidyNameOptions = {}): string {
  let name = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return "";

  // 1. The suffix this store puts on everything, removed as plain text before
  //    any splitting — it may itself contain separators.
  const suffix = (opts.titleSuffix ?? "").trim();
  if (suffix && name.length > suffix.length && name.endsWith(suffix)) {
    name = name.slice(0, -suffix.length).trim();
  }

  // 2. Trailing segments that name the shop or sell rather than describe.
  const storeWords = new Set(
    [...hostWords(opts.host ?? ""), slug(opts.host ?? "")].filter(Boolean),
  );
  //    Segments sit at even indices, the separators between them at odd ones.
  //    What stays is joined with its own separators, never a new one: the colour
  //    grouping reads a colourway off "Nebula Jacket - Black" by its hyphen, and
  //    a name rewritten to "Nebula Jacket — Black" would stop matching its camel
  //    twin.
  const pieces = name.split(TITLE_SPLIT);
  while (pieces.length > 1) {
    const last = pieces[pieces.length - 1].trim();
    if (BOILERPLATE.test(last) || storeWords.has(slug(last))) {
      pieces.splice(-2, 2);
      continue;
    }
    break;
  }
  // A leading segment can be the shop too ("MyStore | Bomber Jacket").
  while (pieces.length > 1 && storeWords.has(slug(pieces[0].trim()))) pieces.splice(0, 2);

  name = pieces.join("").trim();

  // 3. The brand said twice at the front.
  const brand = (opts.brand ?? "").trim();
  if (brand) {
    const doubled = new RegExp(`^(${escapeRe(brand)})\\s+\\1\\b`, "i");
    name = name.replace(doubled, "$1").trim();
  }

  // Trailing punctuation left behind by a removed segment.
  name = name.replace(/[\s,;:|—–·•-]+$/, "").trim();

  // Never hand back nothing: if the rules ate the whole title, the original was
  // a better answer than an empty one.
  return name || (raw ?? "").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The longest trailing text shared by every title given.
 *
 * This is the reliable half of name cleaning: a stop-word list encodes guesses
 * about shops in general, while this measures one shop. If twenty products all
 * end " | MyStore — Купить с доставкой", that string is the shop talking, not
 * any product's name.
 *
 * Needs at least `minTitles` distinct titles before it will claim anything —
 * two products from the same category can legitimately share a tail, twenty
 * cannot. Trimmed back to a separator so it never bites into a word, and
 * ignored unless it starts at one, so a shared word like "Jacket" is not
 * mistaken for furniture.
 */
export function commonTitleSuffix(titles: string[], minTitles = 3): string {
  const uniq = [...new Set((titles ?? []).map((t) => (t ?? "").replace(/\s+/g, " ").trim()))].filter(
    Boolean,
  );
  if (uniq.length < minTitles) return "";

  let suffix = uniq[0];
  for (const t of uniq.slice(1)) {
    let i = 0;
    while (i < suffix.length && i < t.length && suffix[suffix.length - 1 - i] === t[t.length - 1 - i]) {
      i++;
    }
    suffix = suffix.slice(suffix.length - i);
    if (!suffix.trim()) return "";
  }

  // Keep only from the first separator onwards, so the suffix begins where the
  // store's furniture begins rather than mid-word.
  const at = suffix.search(/\s+[|—–·•]\s+|\s+-\s+/);
  if (at === -1) return "";
  const trimmed = suffix.slice(at);
  // A bare separator is not worth subtracting.
  return trimmed.replace(/[\s|—–·•-]/g, "") ? trimmed : "";
}

// ── Strip trailing color suffix from a size-cleaned name ──────────────────────
// "Polo Shirt - Blue" → "Polo Shirt". Used for variant grouping.

export function getBaseProductName(sizeCleanedName: string): string {
  return (sizeCleanedName ?? "").replace(/\s+-\s+[\w/]+$/, "").trim();
}

// ── Parse price handling "49.99", European "49,99", thousands-sep "1.267" ─────

export function parsePrice(raw: string): number {
  if (!raw) return 0;
  const stripped = String(raw).replace(/[^\d.,]/g, "");
  if (!stripped) return 0;
  const lastComma = stripped.lastIndexOf(",");
  const lastDot = stripped.lastIndexOf(".");
  let normalized: string;
  if (lastComma > lastDot) {
    // European decimal: "1.234,99" → "1234.99"
    normalized = stripped.replace(/\./g, "").replace(",", ".");
  } else {
    // European thousands separator: "1.267" (exactly 3 digits after a single dot)
    const thousandsSep = /^(\d{1,3})\.(\d{3})$/.test(stripped);
    normalized = thousandsSep ? stripped.replace(/\./g, "") : stripped.replace(/,/g, "");
  }
  const val = parseFloat(normalized) || 0;
  // Sanity check: prices above 500,000 are scraper artifacts
  return val > 500_000 ? 0 : val;
}

// ── Extract ISO currency code from a display price string ─────────────────────
// Handles: "£49.99", "GBP89.00", "€39,00", "USD 29.99", "4 000 ₴", "12 990 руб".
//
// Two audiences, one function: the CSV feeds, which write a tidy price string,
// and the collect extension, which sends the price as the shopper sees it —
// spaced, localised, sometimes with a word after it. That second case is why
// the symbol table covers more than the currencies the switcher displays and
// why there is a loose ISO pass at the end: a store that prices in złoty is a
// store whose prices we still have to convert correctly.

/** Symbols and words that name a currency outright, most specific first. */
const CURRENCY_MARKERS: [RegExp, string][] = [
  // Dollar signs that are not the US dollar. These come before the bare "$"
  // test, which would otherwise claim every one of them for USD — and each is
  // guarded by a lookbehind so the "S$" inside "US$" cannot be read as the
  // Singapore dollar.
  [/(?<![A-Za-z])US\s?\$/i, "USD"],
  [/(?<![A-Za-z])CA?\s?\$/i, "CAD"],
  [/(?<![A-Za-z])AU?\s?\$/i, "AUD"],
  [/(?<![A-Za-z])NZ\s?\$/i, "NZD"],
  [/(?<![A-Za-z])HK\s?\$/i, "HKD"],
  [/(?<![A-Za-z])SG?\s?\$/i, "SGD"],
  [/(?<![A-Za-z])R\s?\$/, "BRL"],
  // Symbols.
  [/£/, "GBP"],
  [/€/, "EUR"],
  [/₴/, "UAH"],
  [/₽/, "RUB"],
  [/₺/, "TRY"],
  [/₹/, "INR"],
  [/₩/, "KRW"],
  [/₪/, "ILS"],
  [/(?:CN|RM)\s?¥|元/i, "CNY"],
  [/¥/, "JPY"],
  [/zł/, "PLN"],
  [/Kč/, "CZK"],
  [/CHF/i, "CHF"],
  // Words. A price the shopper reads often names its currency in the local
  // language rather than in ISO, and "грн" is what a Ukrainian store writes.
  [/грн/i, "UAH"],
  [/руб/i, "RUB"],
  [/лв/i, "BGN"],
  [/kr/, "SEK"],
  [/\$/, "USD"],
];

/** Codes the loose pass will accept, so "SALE" cannot become a currency. */
const ISO_CODES = new Set([
  "USD", "EUR", "GBP", "UAH", "RUB", "PLN", "CZK", "SEK", "NOK", "DKK", "CHF",
  "CAD", "AUD", "NZD", "JPY", "CNY", "TRY", "INR", "KRW", "HKD", "SGD", "AED",
  "BRL", "MXN", "ILS", "RON", "HUF", "BGN", "ZAR", "THB", "TWD",
]);

export function extractCurrencyFromDisplay(raw: string): string {
  if (!raw) return "";

  for (const [pattern, code] of CURRENCY_MARKERS) {
    if (pattern.test(raw)) return code;
  }

  // A known code standing next to the number: "Price 4 000 UAH incl. VAT".
  //
  // This runs before the anchored tests below, and both halves of the condition
  // earn their place. Without the known-code list, "incl. VAT" at the end of a
  // line reads as a currency — the anchored suffix test accepts any three
  // capitals after a full stop. Without the adjacent digit, "Try it on" makes
  // the Turkish lira out of an English sentence. Together they only fire on a
  // code that is actually pricing something.
  const upper = raw.toUpperCase();
  for (const m of upper.matchAll(/\b[A-Z]{3}\b/g)) {
    const code = m[0];
    if (!ISO_CODES.has(code)) continue;
    const index = m.index ?? 0;
    const around = upper.slice(Math.max(0, index - 8), index + code.length + 8);
    if (/\d/.test(around)) return code;
  }

  // ISO code prefix without space: "GBP89.00"
  const prefixMatch = raw.match(/^([A-Z]{3})\s*[\d.,]/);
  if (prefixMatch) return prefixMatch[1];
  // ISO code suffix: "29.99 GBP". Last, and deliberately unrestricted: a CSV
  // feed may quote a currency this file has never heard of, and at the end of a
  // tidy price string three capitals are what they look like.
  const suffixMatch = raw.match(/[\d.,]\s*([A-Z]{3})$/);
  if (suffixMatch) return suffixMatch[1];
  return "";
}

// ── The currency a store charges in, when no price says it ───────────────────
// Last resort, and a better one than the one it replaces. A page whose markup
// carries a bare "4000" and whose rendered price the extension could not read
// used to be taken as dollars — the "₴4 000 coat at $4 000" again, by the back
// door. The store's address and language are not a statement about one price,
// but they are a statement about the shop: a Ukrainian store sells in hryvnia
// by law, and a `.co.uk` checkout is in pounds. Anything the page itself says
// still wins over this; it only answers where the page said nothing at all.

/** Country (ccTLD or locale region) → the currency its shops charge in. */
const COUNTRY_CURRENCY: Record<string, string> = {
  ua: "UAH", pl: "PLN", cz: "CZK", uk: "GBP", gb: "GBP", ru: "RUB", tr: "TRY",
  se: "SEK", no: "NOK", dk: "DKK", ch: "CHF", hu: "HUF", ro: "RON", il: "ILS",
  jp: "JPY", kr: "KRW", cn: "CNY", hk: "HKD", tw: "TWD", sg: "SGD", th: "THB",
  in: "INR", ae: "AED", za: "ZAR", br: "BRL", mx: "MXN", ca: "CAD", au: "AUD",
  nz: "NZD", us: "USD",
  // Euro area.
  de: "EUR", fr: "EUR", it: "EUR", es: "EUR", nl: "EUR", be: "EUR", at: "EUR",
  ie: "EUR", pt: "EUR", fi: "EUR", gr: "EUR", sk: "EUR", si: "EUR", ee: "EUR",
  lv: "EUR", lt: "EUR", lu: "EUR", mt: "EUR", cy: "EUR", hr: "EUR", eu: "EUR",
};

/**
 * Languages spoken as the main language of one currency's country only.
 *
 * "uk" is Ukrainian here, never the United Kingdom — a `lang` attribute holds a
 * language. German, French, Russian, English and the rest are left out: each is
 * the shop language of several currencies, so it says nothing without a region.
 */
const LANGUAGE_CURRENCY: Record<string, string> = {
  uk: "UAH", pl: "PLN", cs: "CZK", hu: "HUF", sv: "SEK", da: "DKK", nb: "NOK",
  nn: "NOK", no: "NOK", ja: "JPY", ko: "KRW", he: "ILS", tr: "TRY", th: "THB",
};

export interface InferredCurrency {
  code: string;
  /** What gave it away, for the admin: "the .ua address", "the page language (uk-UA)". */
  basis: string;
}

/**
 * The currency a store most likely charges in, from its address and the
 * language its page declares — or null when neither says.
 *
 * The address comes first. A country-code domain is the business's own choice,
 * while a page's `lang` is often a theme default ("en-US" on a Kyiv store).
 * Generic domains (.com, .shop) say nothing and fall through to the language.
 */
export function currencyFromLocale(url: string, lang?: string): InferredCurrency | null {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* no address, only the language can answer */
  }
  const tld = host.split(".").pop() ?? "";
  if (tld && COUNTRY_CURRENCY[tld]) {
    return { code: COUNTRY_CURRENCY[tld], basis: `the .${tld} address` };
  }

  // `uk-UA`, `ru_UA`, `en-GB`: the region is the country, whatever the language.
  const tag = (lang ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!tag) return null;
  const [language, region] = tag.split("-");
  if (region && region.length === 2 && COUNTRY_CURRENCY[region] && region !== "eu") {
    return { code: COUNTRY_CURRENCY[region], basis: `the page language (${lang!.trim()})` };
  }
  if (!region && LANGUAGE_CURRENCY[language]) {
    return { code: LANGUAGE_CURRENCY[language], basis: `the page language (${lang!.trim()})` };
  }
  return null;
}

// ── Product codes ─────────────────────────────────────────────────────────────
// Three kinds of code appear on a product page, and the difference between them
// decides what they may be used for:
//
//   GTIN (EAN/UPC)  the item's own number, issued once for the whole world. Two
//                   pages carrying the same GTIN are the same thing, whoever is
//                   selling it. This is the only code safe to match ACROSS
//                   stores.
//   MPN             the maker's part number. Unique within a brand, so it works
//                   across stores when the brand matches too.
//   SKU             the store's shelf label. Two retailers can and do use the
//                   same SKU string for different things, so it is kept for
//                   reference and never matched on across hosts.
//
// Getting that wrong does not produce a missing link — it produces a coat with
// a "also at" link to a totally different coat, which reads as correct.

/**
 * A GTIN reduced to its digits, or "" when it is not one.
 *
 * The check digit is verified rather than assumed. A page carries plenty of
 * digit strings — a style code, a phone number, a timestamp — and a GTIN field
 * filled with one of those would match another product filled with the same
 * junk. GS1's mod-10 is three lines and turns "is this thirteen digits" into "is
 * this a number the world issued".
 */
export function normalizeGtin(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return "";
  if (/^0+$/.test(digits)) return "";

  // Weights alternate 3 and 1 from the right, excluding the check digit itself.
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10 === check ? digits : "";
}

/** A code kept for reference: trimmed, bounded, and stripped of decoration. */
export function normalizeCode(raw: unknown, max = 60): string {
  return String(raw ?? "")
    .trim()
    .replace(/^(?:ref\.?|sku|art\.?|артикул)\s*[:#]?\s*/i, "")
    .slice(0, max);
}

// ── The store's own spec table ────────────────────────────────────────────────
// Composition, care, country of origin, article number: a store prints them as
// a definition list or a two-column table, and structured data almost never
// carries them. The collect extension sends the rows as they were printed, in
// the store's own language, and these helpers read a field out of them.
//
// This is where "no material" was decided. The parser only ever looked at
// JSON-LD `material`, which is rare enough that most products arrived with the
// field empty while the page said "80% wool, 20% polyamide" two lines under the
// price.

export interface SpecPair {
  key: string;
  value: string;
}

// The trailing guard is a lookahead rather than `\b`, and the flags carry `u`.
// `\b` is defined on ASCII word characters, so it never fires after a Cyrillic
// letter: /^склад\b/ does not match "Склад", which is exactly the key a
// Ukrainian store prints its composition under.

/** Key names that mean composition, in the languages a European store ships. */
export const MATERIAL_KEYS =
  /^(?:material|materials|fabric|composition|made\s*of|fabrication|matière|matiere|tissu|zusammensetzung|materialien|materiale|composizione|composición|tejido|склад|состав|матеріал|материал|тканина|ткань)(?![\p{L}\p{N}])/iu;

/** Key names that mean colour. */
export const COLOR_KEYS =
  /^(?:colou?r|colourway|colorway|farbe|couleur|colore|kolor|barva|цвет|колір|кольор)(?![\p{L}\p{N}])/iu;

/** Key names that mean the brand, which a spec table often states outright. */
export const BRAND_KEYS =
  /^(?:brand|designer|label|maker|manufacturer|marke|marque|marca|бренд|виробник|производитель|торгов\p{L}*\s*марка)(?![\p{L}\p{N}])/iu;

/** Key names that mean the store's own article number. */
export const CODE_KEYS =
  /^(?:sku|mpn|style\s*(?:code|no|number|#)?|product\s*(?:code|id|number)|item\s*(?:code|no|number)|article\s*(?:code|no|number)?|ref(?:erence)?|артикул|код\s*товару|код\s*товара)(?![\p{L}\p{N}])/iu;

/**
 * The value of the first spec row whose key matches, trimmed.
 *
 * First rather than best: a spec table lists each field once, and a page that
 * repeats one (a mobile copy of the same block) repeats the same value.
 */
export function specValue(specs: SpecPair[] | undefined, keys: RegExp): string {
  if (!Array.isArray(specs)) return "";
  for (const pair of specs) {
    const key = String(pair?.key ?? "").trim();
    const value = String(pair?.value ?? "").trim();
    if (!key || !value) continue;
    if (keys.test(key)) return value;
  }
  return "";
}

/**
 * A composition read out of running text: "Outer: 80% wool, 20% polyamide".
 *
 * The last resort for material, and a surprisingly good one — a percentage
 * followed by a fibre is a sentence no marketing copy writes by accident. The
 * whole run of percentages is returned rather than the first, because a garment
 * is its blend and "80% wool" alone misstates it.
 */
export function compositionFromText(text: string): string {
  const source = (text ?? "").replace(/\s+/g, " ");
  if (!source) return "";

  // Read the percentages one at a time and rebuild the blend, rather than
  // matching the whole run in place. A pattern loose enough to span "80% wool,
  // 20% polyamide" is also loose enough to keep going into "with ribbed trims",
  // and a material field that ends mid-sentence reads like a bug because it is
  // one. A fibre is one word, or two when the second is followed by the end of
  // the clause — so "organic cotton," survives and "polyamide with" does not.
  const atom =
    /(\d{1,3})\s?%\s?([\p{L}][\p{L}-]{1,20}(?:\s[\p{L}][\p{L}-]{1,20}(?=\s*(?:[,;./)]|$)))?)/gu;

  const parts: string[] = [];
  let total = 0;
  for (const match of source.matchAll(atom)) {
    const fibre = match[2].trim();
    // "20% off" is not a fibre, and a sale banner sits closer to the price than
    // the composition does. Nor is "20% Unit price" — a Shopify price block
    // reads "-20%" then its unit-price label, and it was stored as the
    // material. So the words after a percentage must name a material.
    if (NOT_A_FIBRE.test(fibre) || !FIBRE.test(fibre)) continue;

    const share = Number(match[1]);
    parts.push(`${share}% ${fibre}`);
    total += share;
    // A composition adds up to 100. Once it does, the next percentage on the
    // page belongs to another part of the garment — "Lining: 100% viscose" —
    // and appending it would state a blend that adds up to two hundred.
    if (total >= 100 || parts.length >= 6) break;
  }
  return parts.join(", ").slice(0, 200);
}

/**
 * Words that name what a thing is made of, as stems: fibres, leathers, foams,
 * metals. Checked as a stem at the start of a word so "cotton", "cottons",
 * "polyester", "polyesters" and "шерстяной" all pass. Qualifiers are not
 * materials: "50% recycled materials" is a claim, "50% recycled polyester" a
 * composition, and only the second names one.
 */
const FIBRE =
  /(?:^|[\s-])(?:cotton|pima|supima|polyester|poly|polyamide|nylon|elasta|spandex|lycra|viscose|rayon|modal|lyocell|tencel|cupro|acetate|triacetate|acrylic|wool|merino|lambswool|cashmere|mohair|alpaca|angora|camel|yak|vicu|silk|linen|flax|hemp|ramie|jute|bamboo|leather|suede|nubuck|shearling|sheepskin|down\b|feather|rubber|eva\b|polyurethane|pu\b|pvc|neoprene|cordura|gore|metal|brass|steel|silver|gold|zinc|copper|textile|synthetic|fibre|fiber|denim|canvas|mesh|fleece|terry|velvet|corduroy|tweed|jersey|хлоп|бавовн|полиэст|поліест|полиамид|поліамід|нейлон|эласт|еласт|спандекс|вискоз|віскоз|модал|акрил|шерст|вовн|кашемир|кашемір|мохер|альпак|шелк|шёлк|шовк|л[её]н|льон|конопл|кож|шкір|замш|резин|гум|текстил|текстиль|синтет|пух|металл|метал)/iu;

/** Words that follow a percentage without being a fibre. */
const NOT_A_FIBRE =
  /^(?:off|discount|sale|extra|more|less|code|promo|cashback|bonus|скидк\p{L}*|знижк\p{L}*|вигод\p{L}*)$/iu;

// ── Is this string a size? ────────────────────────────────────────────────────
// The collect extension reads size labels off the rendered page — buttons, a
// select, a swatch row — because that is where a store puts them and the
// stripped markup keeps none of it. It reads them loosely on purpose: a
// container that mentions "size" also holds "Select size", a size-guide link,
// the quantity stepper and sometimes the word "Sold out". Deciding what is
// actually a size belongs here, next to the other field vocabularies, so the
// extension stays a pair of eyes and the judgement has one home.
//
// What counts, in the spellings a European storefront ships:
//   XS · S · M · XXL · 3XL          letter sizes, and their pairs (S/M, M-L)
//   38 · 40.5 · 9.5                 clothing and shoe numbers
//   EU 38 · UK 10 · US 6 · IT 42    the same with the system named
//   32x34 · W32 L34                 waist and length
//   One size · OS · Единый размер   the size that is not a size
//
// Anything else — a sentence, a price, a colour name, "Add to bag" — is not a
// size, and a wrong size on a product is worse than a missing one: a shopper
// picks it, and nobody finds out until the order.

const LETTER_SIZE = "(?:xx?xs|xs|s|m|l|xl|xxl|xxxl|[2-6]xl)";
const SIZE_SYSTEM = "(?:eu|uk|us|fr|it|de|jp|cn|ru|ua|int)";

const SIZE_PATTERNS: RegExp[] = [
  // Letter sizes, alone or paired: "S", "M/L", "XS-S".
  new RegExp(`^${LETTER_SIZE}(?:\\s?[/–—-]\\s?${LETTER_SIZE})*$`, "i"),
  // A plain number, whole or half: "38", "40,5", "9.5". Bounded below 100 so a
  // price or a product code cannot pass as a size.
  /^\d{1,2}(?:[.,]5)?$/,
  // A number with its system, either order: "EU 38", "38 EU", "UK10".
  new RegExp(`^${SIZE_SYSTEM}\\s?\\d{1,2}(?:[.,]5)?$`, "i"),
  new RegExp(`^\\d{1,2}(?:[.,]5)?\\s?${SIZE_SYSTEM}$`, "i"),
  // Waist and length: "32x34", "32/34", "W32 L34".
  /^\d{2}\s?[x×х/]\s?\d{2}$/i,
  /^w\s?\d{2}\s?l\s?\d{2}$/i,
  // One size, in the words stores write it in.
  /^(?:one[\s-]?size|onesize|os|free[\s-]?size|taille unique|unica|единый размер|один размер|універсальний|безрозмірний)$/i,
];

/** True when `raw` reads as a size a shopper could pick. */
export function looksLikeSize(raw: string): boolean {
  const value = (raw ?? "").trim().replace(/\s+/g, " ");
  // Twenty, not twelve: "Единый размер" and "Taille unique" are sizes and are
  // thirteen characters long. Long enough for the longest real label, short
  // enough that the fit advice under the size row cannot pass.
  if (!value || value.length > 20) return false;
  return SIZE_PATTERNS.some((p) => p.test(value));
}

/**
 * Size labels out of a loose list of candidates: the ones that are sizes, tidied,
 * de-duplicated, in the order the page offered them.
 *
 * Page order is kept rather than sorted because it is the store's own order —
 * XS before XXL, 36 before 46 — and any sort this function invented would have
 * to re-derive it from the labels it just accepted.
 */
export function pickSizes(candidates: unknown, max = 40): string[] {
  const list = Array.isArray(candidates) ? candidates : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const value = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!looksLikeSize(value)) continue;
    const key = value.toLowerCase().replace(/[\s.,]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

// ── How many photos one product keeps ─────────────────────────────────────────
// A fashion product page carries four to a dozen shots — front, back, detail,
// on-model, flat-lay — and the catalogue wants the set, not a sample of it.
// The number is a ceiling on storage and on mirror downloads per import rather
// than a target, and it is shared so the parser, the importer and the mirror
// cannot disagree about it: a cap that differs between them shows up as photos
// that are extracted, stored as URLs, and then never downloaded.

export const MAX_PRODUCT_IMAGES = 20;

// ── Shared category keyword table ─────────────────────────────────────────────
// One ordered rule list, used by BOTH retail-category parsing and product-name
// inference, so a garment is classified the same way whichever field it comes
// from. Rules are ordered **specific → general**: the first match wins, so
// compound terms resolve correctly ("dress shirt" → shirts before dresses,
// "swimsuit" → swimwear before the generic "suit" → blazers, "sweater vest" →
// knitwear before the generic vest → tops, "denim shirt" → shirts before jeans).
// Word boundaries (\b) keep e.g. "bootcut jeans" out of footwear and
// "laptop bag" out of tops. `matchCategory` returns null when nothing matches so
// callers can fall back to another signal instead of silently defaulting to the
// "accessories" junk drawer.
const CATEGORY_RULES: ReadonlyArray<readonly [RegExp, Category]> = [
  // Compound trap: a "dress shirt" is a shirt, not a dress.
  [/\bdress\s*shirt\b/, "shirts"],
  // A polo shirt is a top, not a shirt — it carries "shirt" in its name but the
  // catalogue's own tree files "Polo Shirts" under tops, and this rule read it
  // as `shirts` on every polo in it. Must precede the generic shirt rule below,
  // and must not swallow a "polo neck", which is knitwear.
  [/\bpolo\b(?!\s*neck)/, "tops"],
  // Sneaker / shoe MODEL names that carry no generic garment word (e.g.
  // "Air Max 90", "Adidas Samba", "Nike Dunk"). Placed high so a model name wins
  // — including "Nike Blazer", which would otherwise read as the tailoring
  // "blazer". Brand names alone are intentionally excluded (brands also make
  // apparel: a "Vans tee" must stay a top).
  [/\b(air\s*max|air\s*force|af1|air\s*jordan|jordan\s*\d|nike\s*blazer|\bdunk\b|cortez|vapormax|pegasus|samba|gazelle|superstar|stan\s*smith|ozweego|adilette|ultra\s?boost|nmd|yeezy\s*(?:boost|slide|foam|\d)|new\s*balance\s*\d+|chuck\s*taylor|sk8-?hi|old\s*skool|birkenstock|crocs|uggs?)\b/, "footwear"],
  // Footwear is high-priority so a shoe word beats garment words elsewhere in the
  // name — "Bermuda Shoes" / "Denim Loafers" read as footwear, not shorts/jeans.
  // "boot" is guarded against "boot cut" (jeans); "shoe" against "shoe bag/box".
  [/\b(footwear|shoes?(?!\s*(?:bag|box|tree|horn|care|lace|rack))|boots?(?!\s*-?cut)|trainers?|sneakers?|sandals?|slides?|sliders?|loafers?|heels?|pumps?|espadrilles?|mules?|brogues?|derbys?|plimsolls?|hi-?tops?|high-?tops?|low-?tops?|slippers?|flip-?flops?|clogs?|moccasins?)\b/, "footwear"],
  // Shorts first — "swim/swimming/board/beach shorts" should read as shorts, not
  // swimwear. Require plural "shorts" (or a qualifier) to avoid "short sleeve".
  [/\b(shorts|bermudas?|(chino|cargo|denim|cycling|running|sweat|board|swim|swimming|beach)\s*shorts?)\b/, "shorts"],
  // True swimwear only (shorts already handled above).
  [/\b(swim(wear|suit|ming)?|bikini|beachwear|trunks|rash\s*guard)\b/, "swimwear"],
  // One-piece sets (before the generic "suit").
  [/\b(jumpsuit|playsuit|dungarees?|overalls?|boilersuit|catsuit|romper|onesie)\b/, "jumpsuits"],
  // Outerwear, incl. sleeveless outer layers (gilet / puffer vest).
  [/\b(jacket|coat|outerwear|parka|anorak|windbreaker|bomber|trench|puffer|raincoat|overcoat|peacoat|mackintosh|poncho|cape|gilet|(puffer|padded|quilted|down|shell)\s*vest)\b/, "outerwear"],
  // Tailoring / suiting. Bare "suit" is included but \b keeps it from matching
  // swimsuit / jumpsuit / tracksuit / bodysuit (all handled by earlier rules) and
  // from matching the verb "suits"/"suited".
  [/\b(blazer|waistcoat|tuxedo|suit)\b/, "blazers"],
  // Knitwear (before generic tops; catches sweater / knit vests too).
  [/\b(knitwear|knit|sweater|jumper|cardigan|turtleneck|rollneck|roll\s*neck|polo\s*neck|funnel\s*neck|pullover|(sweater|knit)\s*vest)\b/, "knitwear"],
  [/\b(skirt|kilt)\b/, "skirts"],
  [/\b(dress|gown|frock|sundress|kaftan|caftan)\b/, "dresses"],
  // Tees / tanks (before the generic "shirt", so "t-shirt" → tops not shirts).
  [/\b(t[-\s]?shirt|tee|tank(\s*top)?|camisole|cami|singlet|crop\s*top|vest\s*top)\b/, "tops"],
  [/\b(shirt|overshirt|shacket|oxford|flannel|chambray)\b/, "shirts"],
  // Remaining upper-body pieces.
  [/\b(hoodie|sweatshirt|blouse|polo|bodysuit|tunic|bralette|\btop\b|vest)\b/, "tops"],
  // Crewnecks described only as "crew" (e.g. "long-sleeve crew"); never "crew socks".
  [/\bcrew(?:neck)?\b(?!\s*socks?)|\bcrew[-\s]neck\b/, "tops"],
  [/\b(jeans?|denim)\b(?!\s*jacket)/, "jeans"],
  [/\b(trousers?|pants?(?!y)|chinos?|leggings?|joggers?|sweatpants?|tracksuit|culottes?|slacks)\b/, "bottoms"],
  [/\b(bag|backpack|rucksack|handbag|tote|clutch|satchel|holdall|luggage|suitcase|briefcase|crossbody|messenger\s*bag|duffel|pouch)\b/, "bags"],
  // Explicit accessories (so ties/belts/hats are matched, not just left to fall through).
  [/\b(belt|tie|bow\s*tie|scarf|scarves|hats?|caps?|beanie|gloves?|mittens?|socks?|sunglasses|jewellery|jewelry|necklace|bracelet|earrings?|watch|wallet|cardholder|purse|umbrella|keyring|headband|bandana|cufflinks?|suspenders?|braces)\b/, "accessories"],
];

// Russian-language keywords. Much of the catalog is named/described in Russian,
// which the English table above can't read. Cyrillic word boundaries aren't
// handled by \b, so these are plain stem substrings (matched on lowercased
// text), ordered specific → general and consulted ONLY when the English pass
// finds nothing — so they never override an English match. "шорт" is checked
// before swim/"купальн" so "купальные шорты" reads as shorts, mirroring English.
const CATEGORY_RULES_RU: ReadonlyArray<readonly [RegExp, Category]> = [
  [/шорт/, "shorts"],
  [/купальник|плавк|купальн|бикини/, "swimwear"],
  [/комбинезон/, "jumpsuits"],
  [/куртк|пальто|плащ|парк|пухов|ветровк|бомбер|тренч|дублёнк|дубленк|шуба|шубы|анорак|пончо|накидк/, "outerwear"],
  [/пиджак|блейзер|смокинг|жакет/, "blazers"],
  [/кофт|свитер|джемпер|кардиган|водолазк|пуловер/, "knitwear"],
  [/юбк/, "skirts"],
  [/плать|сарафан/, "dresses"],
  [/футболк|майк|блузк|худи|свитшот|толстовк|кроп.?топ/, "tops"],
  [/рубашк|сорочк/, "shirts"],
  [/джинс|деним/, "jeans"],
  [/брюк|штан|легинс|лосин|джоггер|чинос/, "bottoms"],
  [/обувь|ботинк|кроссовк|кросс|кеды|туфл|сапог|сандал|лофер|босонож|мокасин|балетк|слайд|\bугг/, "footwear"],
  [/сумк|рюкзак|клатч|портфель|чемодан|барсетк/, "bags"],
  [/ремень|ремни|галстук|шарф|платок|платк|шапк|кепк|берет|перчатк|варежк|носк|носок|очки|часы|кошел|бабочк|запонк|подтяжк|ободок/, "accessories"],
];

/**
 * The category the rule table above assigns, on its own — kept separately so
 * the garment dictionary's answers can be compared against it.
 */
export function matchCategoryByRules(text: string): Category | null {
  const t = (text ?? "").toLowerCase();
  if (!t) return null;
  for (const [re, cat] of CATEGORY_RULES) if (re.test(t)) return cat;
  // Fall back to Russian keywords only when the English table matched nothing.
  for (const [re, cat] of CATEGORY_RULES_RU) if (re.test(t)) return cat;
  return null;
}

/**
 * First matching category for a free-text string, or null if none matched.
 *
 * The garment dictionary answers first. It knows far more names than the rule
 * table ("Harrington", "Sukajan", "косуха", "берцы"), and it reads a title the
 * way the title is built — by its head noun — so "Pullover Hoodie", "Knit
 * Dress" and "Suit Jacket" come out as a hoodie, a dress and tailoring, where
 * the first-match rules stopped at "pullover", "knit" and "jacket".
 *
 * It answers only from strong evidence. A title whose only garment word is a
 * fabric ("denim", "knit") falls through to the rules, which have handled those
 * cases for a long time and whose traps ("boot cut", "shoe bag") stay in force.
 */
export function matchCategory(text: string): Category | null {
  return garmentCategory(text ?? "") ?? matchCategoryByRules(text);
}

// ── Retail category path → { category, gender } ───────────────────────────────
// Works for AWIN `category_name`, Farfetch breadcrumbs, generic category strings.

export function parseRetailCategory(raw: string): { category: Category; gender?: Gender } {
  const t = (raw ?? "").toLowerCase();

  let gender: Gender | undefined;
  if (/^(women|girls|ladies|femme|woman)/.test(t)) gender = "women";
  else if (/^(men|boys|homme|man\b)/.test(t)) gender = "men";
  else if (/unisex/.test(t)) gender = "unisex";

  return { category: matchCategory(t) ?? "accessories", gender };
}

// ── Fallback category from a free-text product name ───────────────────────────

export function inferCategoryFromName(text: string): Category {
  return matchCategory(text) ?? "accessories";
}

// ── Infer gender from free text (suitable-for field, URL segment, etc.) ───────

export function inferGenderFromText(text: string): Gender | undefined {
  const t = (text ?? "").toLowerCase();
  if (!t) return undefined;
  if (/\bwomen\b|\bwomens\b|female|ladies|\bgirl|femme|\/women\//.test(t)) return "women";
  if (/\bmen\b|\bmens\b|\bmale\b|\bboy|homme|\/men\//.test(t)) return "men";
  if (/unisex/.test(t)) return "unisex";
  return undefined;
}

// ── Map color name → hex for variant swatches ─────────────────────────────────

export const COLOR_HEX: Record<string, string> = {
  black: "#111111", white: "#f5f5f5", grey: "#808080", gray: "#808080",
  blue: "#1a47a0", navy: "#001f5b", "navy blue": "#001f5b",
  red: "#c0392b", green: "#2d6a3f", beige: "#d4c5a9", pink: "#e8698a",
  orange: "#e87722", yellow: "#f5c518", purple: "#7b3fa0", violet: "#7b3fa0",
  brown: "#7a4f35", cream: "#f5f0e8", khaki: "#c3b091", camel: "#c19a6b",
  burgundy: "#800020", wine: "#722f37", stone: "#c2b280", sand: "#c2b280",
  silver: "#c0c0c0", gold: "#ffd700", "rose gold": "#b76e79",
  teal: "#008080", mint: "#98d8c8", lilac: "#c8a2c8", coral: "#ff6b6b",
  "off white": "#f5f0e8", ecru: "#f5f0e8", ivory: "#fffff0",
};

export function colorToHex(colorName: string): string {
  const key = (colorName ?? "").toLowerCase().trim();
  const exact = COLOR_HEX[key];
  if (exact) return exact;
  // "Core Black", "Cloud White", "Deep Navy Blue": a colourway is a base colour
  // with marketing in front of it. Reading the base out is what stops every
  // such product from landing on the grey placeholder swatch. The argument is
  // always a colour label, so the field vocabulary applies.
  const base = canonicalColor(key, "field");
  return base ? BASE_COLOR_HEX[base] : "#888888";
}

// ── Colourways → the catalogue's own colour vocabulary ────────────────────────
//
// A store writes whatever it likes on the page: "Core Black", "Noir", "Cloud
// White", "Blu Navy", "чёрный". The catalogue files a product under the colour
// groups the browse filter is built from (`color_groups`: White, Multicolor,
// Brown, Pink, Yellow, Orange, Grey, Black, Green, Red, Violet, Blue, Beige),
// and paints its swatch from one hex. Both need the store's label reduced to
// one of a fixed set of base colours first — that reduction lives here, so the
// CSV importer and the URL parser agree on what "Deep Sea Blue" is.

export type BaseColor =
  | "black" | "white" | "grey" | "beige" | "brown" | "blue"
  | "green" | "red" | "pink" | "yellow" | "orange" | "violet";

/** The `color_groups` row each base colour belongs to. */
const BASE_COLOR_GROUP: Record<BaseColor, string> = {
  black: "Black", white: "White", grey: "Grey", beige: "Beige",
  brown: "Brown", blue: "Blue", green: "Green", red: "Red",
  pink: "Pink", yellow: "Yellow", orange: "Orange", violet: "Violet",
};

/** Swatch hex for a base colour — the same values the colour groups carry. */
const BASE_COLOR_HEX: Record<BaseColor, string> = {
  black: "#111111", white: "#f5f5f5", grey: "#808080", beige: "#d4c5a9",
  brown: "#7a4f35", blue: "#1a47a0", green: "#2d6a3f", red: "#c0392b",
  pink: "#e8698a", yellow: "#f5c518", orange: "#e87722", violet: "#7b3fa0",
};

/** The group name that means "more than one colour", per `lib/color-groups`. */
export const MULTICOLOR_GROUP = "Multicolor";

/**
 * Where a colour word is being read from.
 *
 *   "text"   a product name, a URL slug, page markup — anything that is not
 *            known to be a colour. Only words that mean a colour everywhere
 *            count, so "Stone Island" and "Linen Shirt" name no colour.
 *   "field"  the store's colour field or a swatch label: the text IS a colour,
 *            so "Stone", "Linen" and "Sky" read as colours too.
 *
 * The vocabulary itself is in `lib/taxonomy/colours`.
 */
export type ColourSource = "text" | "field";

/** 0 = safe word or phrase, 1 = field-only word, 2 = qualifier ("Marl"). Lower wins. */
interface ColourHit { base: BaseColor; at: number; rank: 0 | 1 | 2 }

function colourHits(text: string, source: ColourSource): ColourHit[] {
  let rest = (text ?? "").toLowerCase();
  if (!rest) return [];
  const field = source === "field";

  const hits: ColourHit[] = [];
  // Phrases first, blanked out in place so the words inside them are not read
  // again and every later hit keeps its position.
  for (const [re, base] of COLOUR_PHRASES) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    rest = rest.replace(global, (m, ...args) => {
      hits.push({ base, at: args[args.length - 2] as number, rank: 0 });
      return " ".repeat(m.length);
    });
  }

  for (const m of rest.matchAll(/\p{L}+/gu)) {
    const word = m[0];
    if (word.length < 3) continue;
    const at = m.index ?? 0;
    const safe = SAFE_COLOUR_WORDS[word] ?? COLOUR_STEMS.find(([re]) => re.test(word))?.[1];
    if (safe) { hits.push({ base: safe, at, rank: 0 }); continue; }
    if (!field) continue;
    const fieldOnly = FIELD_COLOUR_WORDS[word] ?? FIELD_COLOUR_STEMS.find(([re]) => re.test(word))?.[1];
    if (fieldOnly) { hits.push({ base: fieldOnly, at, rank: 1 }); continue; }
    const qualifier = QUALIFIER_COLOUR_WORDS[word] ?? QUALIFIER_COLOUR_STEMS.find(([re]) => re.test(word))?.[1];
    if (qualifier) hits.push({ base: qualifier, at, rank: 2 });
  }
  return hits.sort((a, b) => a.at - b.at);
}

/**
 * Every base colour named in a piece of text, in the order it reads.
 * Non-colour words are ignored, so "Men's Cruiser — Shadow Blue" yields ["blue"].
 */
export function colorWordsIn(text: string, source: ColourSource = "text"): BaseColor[] {
  return colourHits(text, source).map((h) => h.base);
}

/**
 * Could this string be the name of a colour, as a shop writes one — rather than
 * a file, an address or a code that happened to sit where the colour should?
 *
 * The collect extension reads the selected swatch, and a swatch is often a tiny
 * product photo whose `alt` or `title` is its file name. So "A35893_1.jpg" and
 * "A35224-BabymetalStorm-1.jpg" were stored as colours, shown to shoppers, and
 * left the colour filter empty because no colour word is in them. A colour name
 * is words; these shapes never are:
 *
 *   - a file name (an image extension),
 *   - an address (a scheme, `//`, a leading slash),
 *   - anything with an underscore — how files and codes are joined, never names,
 *   - one token mixing letters with two or more digits ("A35893", "BLK001"),
 *   - no letters at all ("0012"), or a hex value ("#1a1a1a").
 *
 * "Black/White", "010 Black" and "Core Black" all pass.
 */
export function looksLikeColourLabel(raw: string | undefined | null): boolean {
  const v = (raw ?? "").trim();
  if (v.length < 2 || v.length > 40) return false;
  if (/\.(?:jpe?g|png|webp|gif|avif|svg|bmp|tiff?|heic)(?:[?#].*)?$/i.test(v)) return false;
  if (/:\/\/|^\/|^www\./i.test(v)) return false;
  if (v.includes("_")) return false;
  if (!/\p{L}/u.test(v)) return false;
  if (v.startsWith("#")) return false;
  if (!/\s/.test(v) && /\d.*\d/.test(v)) return false;
  if (/^(?:select|choose|pick)\b/i.test(v)) return false;
  return true;
}

/**
 * The one base colour a label names, or undefined when it names none.
 *
 * The LAST colour word wins, because a colourway puts its qualifier in front of
 * the colour: "Natural Black" is a black shoe, "Cloud White" a white one. Taking
 * the first would file both under the qualifier. A word that means a colour
 * everywhere outranks one that only does in a colour field, so "Black Linen" is
 * black however the words are ordered, and "Navy Marl" is navy.
 */
export function canonicalColor(label: string, source: ColourSource = "text"): BaseColor | undefined {
  const hits = colourHits(label, source);
  if (!hits.length) return undefined;
  const best = Math.min(...hits.map((h) => h.rank));
  return hits.filter((h) => h.rank === best).pop()?.base;
}

/**
 * The colour-group names a label belongs in — what the browse filter files it
 * under. A label that names two colours ("Black/White", "Blue & Green") returns
 * both plus Multicolor, which is the group `lib/color-groups` treats as the
 * truthful single label for a piece that is more than one colour.
 *
 * Splitting on separators is what distinguishes a two-colour piece from a
 * two-word colourway: "Natural Black" is one colour, "Natural/Black" is two.
 *
 * Read from a colour field, "Multi", "Camo" and "Tie-Dye" say Multicolor on
 * their own; from a name they say nothing ("Camo Cargo" is a print, and the
 * variant being imported may be the plain one).
 */
export function colorGroupNamesFor(labels: string | string[], source: ColourSource = "text"): string[] {
  const list = (Array.isArray(labels) ? labels : [labels]).filter(Boolean);
  const bases: BaseColor[] = [];
  let multi = false;
  for (const label of list) {
    if (source === "field" && MULTICOLOUR_WORDS.test(String(label))) multi = true;
    for (const part of String(label).split(/[/,&+·|]|\band\b|\sи\s/i)) {
      const base = canonicalColor(part, source);
      if (base && !bases.includes(base)) bases.push(base);
    }
  }
  const names = bases.map((b) => BASE_COLOR_GROUP[b]);
  return bases.length > 1 || multi ? [...names, MULTICOLOR_GROUP] : names;
}

// ── Resolve the *store* name a product is sold at from its source URL ─────────
// The store is where you buy it (e.g. a Farfetch link → "Farfetch"), which is
// NOT the same as the brand. Affiliate feeds sometimes omit a merchant column,
// and falling back to the brand makes the "Where to buy" row show the brand as
// if it were the store — so we derive the store from the link host instead.

// Pretty display names for common multi-brand retailers, so the resolved store
// name matches the admin store library (and its logo) rather than a raw domain.
const KNOWN_STORES: Record<string, string> = {
  farfetch: "Farfetch",
  ssense: "SSENSE",
  mrporter: "Mr Porter",
  "net-a-porter": "Net-A-Porter",
  netaporter: "Net-A-Porter",
  endclothing: "END.",
  matchesfashion: "Matches",
  mytheresa: "Mytheresa",
  nordstrom: "Nordstrom",
  selfridges: "Selfridges",
  zalando: "Zalando",
  asos: "ASOS",
};

// Affiliate-network tracker domains: a link host here is a redirect, not the
// actual store, so we can't name the store from it — fall back to the caller's
// fallback instead of showing e.g. "Awin1".
const AFFILIATE_TRACKERS = new Set([
  "awin1", "productserve", "prf", "zenaps", "webgains", "tradedoubler",
  "linksynergy", "go", "click", "redirectingat", "dpbolvw", "anrdoezrs",
  "jdoqocy", "kqzyfj", "tkqlhce",
]);

/**
 * Second-level labels a country registry sells under: "shop.com.ua",
 * "brand.co.uk", "store.kiev.ua". The shop's name is the label before them —
 * reading these as the name called every Ukrainian `.com.ua` store "Com", and
 * two such stores on one product then overwrote each other in "Where to buy".
 */
const REGISTRY_LABELS = new Set(["com", "co", "org", "net", "gov", "edu", "ac", "biz", "in", "kiev", "kyiv"]);

export function storeNameFromUrl(url: string, fallback = ""): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const labels = host.split(".");
    let root = (labels.slice(-2, -1)[0] ?? host).toLowerCase();
    if (REGISTRY_LABELS.has(root) && labels.length >= 3) root = labels[labels.length - 3].toLowerCase();
    if (!root || AFFILIATE_TRACKERS.has(root)) return fallback || "Store";
    if (KNOWN_STORES[root]) return KNOWN_STORES[root];
    return root.charAt(0).toUpperCase() + root.slice(1);
  } catch {
    return fallback || "Store";
  }
}

// True only when the source link is the brand's own website (host contains the
// brand slug), e.g. versace.com for Versace — never a multi-brand marketplace.
export function isOfficialStore(url: string, brand: string): boolean {
  const b = (brand ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (b.length < 3) return false;
  try {
    const host = new URL(url).hostname
      .replace(/^www\./, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    return host.includes(b);
  } catch {
    return false;
  }
}

// ── Request a higher-resolution variant of a product image URL ─────────────────
// `upscaleImageUrl` now lives in `@/lib/image` so it can run client-side inside
// the image component, where a failed rewrite can fall back to the original URL.
export { upscaleImageUrl } from "@/lib/image";
