/**
 * Who a piece is for, as the page says it.
 *
 * Only what the page states. What a store means by saying nothing — a brand
 * whose site has "All" and "Women" and no "Men", where "All" means men's at one
 * brand and unisex at the next — is not in the words at all; that is the store
 * setting and the catalogue's history (`catalogue-profile.ts`).
 *
 * Where the words are read matters as much as which words:
 *
 *   name         the strongest statement. "Unisex" wins outright, and a name
 *                that names both ("Men's & Women's Tee") is unisex.
 *   address      a path segment or breadcrumb: "/women/", "Men > Jackets".
 *                Read the same way as a name.
 *   description  the weakest. Copy says "the model is a woman wearing a size S"
 *                and "men should size up" about pieces for anyone, so a
 *                description that names both genders says nothing, and one
 *                that names one is believed only when nothing stronger spoke.
 *
 * The rules this replaces tested women first on name and description together:
 * "adidas Unisex Torsion Comp Shoes" read as women because its description
 * mentioned women, and "Boyfriend Jeans" read as men from "boy".
 */
import type { Gender } from "@/lib/types";

export type GenderSource = "name" | "address" | "description";

// Not "boy", "girl", "lady": "Boyfriend Jeans", "Bad Boy Tee", "Lady Dior" and
// "Girl Skateboards" are not statements about the wearer. The plurals are.
const WOMEN = [
  "women", "womens", "womenswear", "female", "ladies", "girls", "femme", "femmes", "damen", "for her",
  // Russian and Ukrainian, as stems.
  "женск", "для женщин", "девочк", "жіноч", "для жінок", "дівчат",
];
const MEN = [
  "men", "mens", "menswear", "male", "gents", "boys", "homme", "hommes", "herren", "for him",
  "мужск", "для мужчин", "мальчик", "чоловіч", "для чоловіків", "хлопчик",
];
const UNISEX = [
  "unisex", "uni sex", "genderless", "gender neutral", "all gender", "gender free", "genderfree",
  "унисекс", "унісекс",
];
/**
 * Only in an address, where a word is a section rather than a name:
 * "zara.com/…/woman-…", "/donna/" (and not Donna Karan), transliterated slugs.
 */
const ADDRESS_WOMEN = [
  "woman", "donna", "mujer", "zhenskaya", "zhenskie", "zhenskoe", "zhinochi", "zhinocha", "zhinkam",
];
const ADDRESS_MEN = [
  "man", "uomo", "hombre", "muzhskaya", "muzhskie", "muzhskoe", "cholovichi", "cholovicha", "cholovikam",
];

const isCyrillic = (s: string) => /[Ѐ-ӿ]/.test(s);

/** Whole words for Latin terms, stems for Cyrillic — the dictionaries' usual rule. */
function compile(terms: string[]): RegExp {
  const parts = terms.map((t) => {
    const words = t.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return isCyrillic(t) ? `${words.join(" ")}\\p{L}*` : words.join(" ");
  });
  return new RegExp(` (?:${parts.join("|")})(?= )`, "u");
}

const RE = {
  women: compile(WOMEN),
  men: compile(MEN),
  unisex: compile(UNISEX),
  addressWomen: compile([...WOMEN, ...ADDRESS_WOMEN]),
  addressMen: compile([...MEN, ...ADDRESS_MEN]),
};

/** Lowercase, apostrophes dropped ("men's" → "mens"), every other non-letter a space, padded. */
function normalize(text: string): string {
  return ` ${(text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

/** The gender a piece of text states, read by the rules of where it came from. */
export function readGender(text: string, source: GenderSource): Gender | undefined {
  const hay = normalize(text);
  if (hay.trim().length === 0) return undefined;
  if (RE.unisex.test(hay)) return "unisex";
  const address = source === "address";
  const women = (address ? RE.addressWomen : RE.women).test(hay);
  const men = (address ? RE.addressMen : RE.men).test(hay);
  if (source === "description") {
    // "Our model is a woman wearing a size S; men should size up" — the singular
    // never decides, but it does make a description that names the other
    // gender too an ambiguous one.
    const anyWomen = women || / woman /.test(hay);
    const anyMen = men || / man /.test(hay);
    if (anyWomen && anyMen) return undefined;
  }
  if (women && men) return "unisex";
  if (women) return "women";
  if (men) return "men";
  return undefined;
}

/** The path of a link, without the host: "shop-women.com" is a domain, not a statement. */
export function addressText(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return "";
  }
}

/**
 * The page's own answer, strongest statement first: the name, then the
 * address and breadcrumbs, then the description. Undefined when the page is
 * silent — which is the case the store setting and the catalogue's history
 * exist for.
 */
export function genderFromPage(page: {
  name?: string;
  url?: string;
  breadcrumbs?: string;
  description?: string;
}): { gender: Gender; source: GenderSource } | undefined {
  const reads: [string | undefined, GenderSource][] = [
    [page.name, "name"],
    [page.url ? addressText(page.url) : undefined, "address"],
    [page.breadcrumbs, "address"],
    [page.description, "description"],
  ];
  for (const [text, source] of reads) {
    if (!text) continue;
    const gender = readGender(text, source);
    if (gender) return { gender, source };
  }
  return undefined;
}
