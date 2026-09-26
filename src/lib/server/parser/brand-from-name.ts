/**
 * The brand, read off the product's name when the page did not say it — or
 * said the shop instead.
 *
 * A multi-brand store is where this matters. Its structured data leaves the
 * brand out, or fills it with the store's own name, and the brand is sitting in
 * plain sight at the front of the title: "Кросівки Nike Air Max 90",
 * "Acne Studios wool scarf". Every such product used to land with an empty or
 * wrong brand for an admin to fix by hand, one row at a time.
 *
 * Pure: the caller supplies the brands it knows (the admin's Brands list and the
 * brands already in the catalogue) and this only decides. A name is only ever
 * matched against that list, never mined for a capitalised word, so an unknown
 * brand stays unknown rather than becoming "Oversized".
 */

/** Values a catalogue row can carry in `brand` that are not a brand. */
const NOT_A_BRAND = new Set([
  "", "unknown", "brand", "other", "others", "none", "n/a", "na", "no brand",
  "nobrand", "generic", "unbranded", "default", "без бренда", "без бренду",
  "інше", "другое",
]);

/** Case, accents and spacing folded away, for comparing two spellings of one brand. */
export function foldBrand(value: string): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Letters and digits only, for comparing a brand to the labels of a host. */
function compact(value: string): string {
  return foldBrand(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Is this brand spelled, as whole words, inside `text`? Returns where, or -1. */
function positionIn(text: string, brand: string): number {
  const pattern = escapeRe(foldBrand(brand)).replace(/ /g, "\\s+");
  // Not `\b`: it only knows ASCII letters, so "Кросівки Nike" and "Stüssy"
  // would get their boundaries wrong. A brand must not continue into a letter
  // or digit on either side — "Cos" is not in "Cosy", "Arket" not in "Market".
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "u");
  const m = re.exec(foldBrand(text));
  return m ? m.index : -1;
}

/**
 * The known brands worth matching, de-duplicated by folded spelling. The first
 * spelling seen wins, so pass the admin's curated list before the catalogue's.
 */
export function brandVocabulary(...lists: string[][]): string[] {
  const byFold = new Map<string, string>();
  for (const list of lists) {
    for (const raw of list) {
      const name = String(raw ?? "").replace(/\s+/g, " ").trim();
      const fold = foldBrand(name);
      // Two characters is a real brand ("A.P.C." compacts to three, "Uniqlo"
      // is long); one is a letter that matches half the catalogue.
      if (compact(name).length < 2 || NOT_A_BRAND.has(fold)) continue;
      if (!byFold.has(fold)) byFold.set(fold, name);
    }
  }
  return [...byFold.values()];
}

/**
 * The known brand a product name names, or "" when it names none.
 *
 * The earliest brand in the name wins — a brand leads its product's title far
 * more often than it trails it, and "Nike x Sacai" is Nike's shoe. At the same
 * position the longest wins, so "Acne Studios" beats "Acne".
 */
export function brandInName(name: string, brands: string[]): string {
  let best = "";
  let bestAt = Infinity;
  for (const brand of brands) {
    const at = positionIn(name, brand);
    if (at < 0) continue;
    if (at < bestAt || (at === bestAt && brand.length > best.length)) {
      best = brand;
      bestAt = at;
    }
  }
  return best;
}

export interface BrandDecision {
  brand: string;
  /** Set when the name decided it, for the import to say so. */
  fromName?: boolean;
}

/**
 * The brand to store: the page's own word, unless the name says better.
 *
 * `stated` is what the page (or an admin's recipe) gave as the brand; `host` is
 * the store's address. The name takes over when the page said nothing, when it
 * said the store's own name ("Intertop" on intertop.ua is the shop, not the
 * maker), or when it said something we have never seen as a brand and the name
 * does not repeat. A stated brand the name confirms, or one the catalogue
 * already knows, is kept — structured data is still the store's word.
 */
export function decideBrand(input: {
  stated: string;
  name: string;
  host: string;
  known: string[];
}): BrandDecision {
  const stated = (input.stated ?? "").replace(/\s+/g, " ").trim();
  const statedFold = foldBrand(stated);
  // The catalogue's spelling of the stated brand, so "NIKE" files under "Nike"
  // rather than starting a second entry in the brand filter.
  const canonical =
    (statedFold && input.known.find((b) => foldBrand(b) === statedFold)) || stated;

  const fromName = brandInName(input.name, input.known);
  if (!fromName || foldBrand(fromName) === statedFold) {
    return { brand: NOT_A_BRAND.has(statedFold) ? "" : canonical };
  }

  if (!stated || NOT_A_BRAND.has(statedFold)) return { brand: fromName, fromName: true };

  // The name repeats the stated brand: it is confirmed, whatever else it names.
  if (positionIn(input.name, stated) >= 0) return { brand: canonical };

  // The store's own name, given as the brand.
  const labels = (input.host ?? "").toLowerCase().split(".").map(compact).filter(Boolean);
  if (labels.includes(compact(stated))) return { brand: fromName, fromName: true };

  const statedIsKnown = input.known.some((b) => foldBrand(b) === statedFold);
  return statedIsKnown ? { brand: canonical } : { brand: fromName, fromName: true };
}
