/**
 * Normalise a RawExtract into a ParsedProduct, reusing the shared field helpers
 * so URL imports behave exactly like CSV imports (price/currency/category/gender
 * inference are identical).
 */
import {
  cleanName,
  parsePrice,
  extractCurrencyFromDisplay,
  MAX_PRODUCT_IMAGES,
  matchCategory,
  inferGenderFromText,
  canonicalColor,
} from "@/lib/server/product-fields";
import type { RawExtract, ParserSiteConfig, ParsedProduct } from "./types";
import { upgradeImageUrl, imageKey } from "./gallery";

/** Resolve a possibly-relative image URL against the page URL. */
function absoluteUrl(src: string, base: string): string | null {
  if (!src) return null;
  try {
    if (src.startsWith("//")) return new URL(base).protocol + src;
    return new URL(src, base).toString();
  } catch {
    return null;
  }
}

/**
 * The currency this price is in, or "" when the page never said.
 *
 * Returning "" rather than "USD" is the point. The importer converts what it
 * can into dollars, and a currency it merely assumed would be converted by a
 * rate that has nothing to do with the price — or, worse, left alone and
 * counted as dollars, which is how a ₴4,000 coat arrived in the catalogue
 * priced like a designer one. An empty answer is a fact the caller can act on;
 * a defaulted one is a guess wearing a fact's clothes.
 */
function normalizeCurrency(rawCurrency: string | undefined, rawPrice: string | undefined): string {
  const c = (rawCurrency ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(c)) return c;
  return (extractCurrencyFromDisplay(rawCurrency ?? "") || extractCurrencyFromDisplay(rawPrice ?? "")).toUpperCase();
}

export function normalizeExtract(
  raw: RawExtract,
  sourceUrl: string,
  config?: ParserSiteConfig | null,
): ParsedProduct {
  const issues: string[] = [];

  const name = cleanName(raw.name ?? "");
  if (!name) issues.push("missing name");

  const brand = (config?.brandOverride || raw.brand || "").trim();

  const price = parsePrice(raw.price ?? "");
  if (!price) issues.push("missing price");
  const priceOriginal = parsePrice(raw.priceOriginal ?? "");

  const currency = normalizeCurrency(raw.currency, raw.price);
  if (price && !currency) issues.push("currency not stated");

  // Category: explicit override → product name/description → URL path hint.
  // Prefer the name-based guess; only fall back to the URL path when the name
  // yields nothing, and to "accessories" only when neither signal matches.
  const category =
    config?.categoryOverride ??
    // The name only. Measured on held-out products, name-only classifies at
    // 92% against 88% when the description is included: descriptions name-drop
    // other garments, and "pairs well with shorts" reads as "is shorts".
    matchCategory(name) ??
    matchCategory(safePath(sourceUrl)) ??
    "accessories";

  // Gender: explicit override → URL → name/description
  const gender =
    config?.genderOverride ??
    inferGenderFromText(sourceUrl) ??
    inferGenderFromText(`${name} ${raw.description ?? ""}`);

  // Images: resolve to absolute URLs, ask the CDN for the full-resolution
  // original, then dedupe by photo identity rather than by string.
  //
  // Both steps earn their keep. Structured data hands back the same photo at
  // several renditions — a live Cuyana page advertises `…_2785_1024x.jpg`,
  // `…_2785.jpg` and `…_2785_600x600_crop_center.jpg` as three separate images —
  // so string dedupe stored one photo three times and mirrored it three times.
  // And a page that requests `?width=300` markup would otherwise have its
  // gallery mirrored at 300px, which is useless for a catalog.
  const byPhoto = new Map<string, string>();
  for (const u of raw.images ?? []) {
    const abs = absoluteUrl(u, sourceUrl);
    if (!abs) continue;
    const full = upgradeImageUrl(abs, sourceUrl) ?? abs;
    const key = imageKey(full);
    if (!byPhoto.has(key)) byPhoto.set(key, full);
  }
  const images = [...byPhoto.values()].slice(0, MAX_PRODUCT_IMAGES);

  const rawAbs = raw.image && absoluteUrl(raw.image, sourceUrl);
  const rawPrimary = rawAbs ? (upgradeImageUrl(rawAbs, sourceUrl) ?? rawAbs) : null;
  // Take the gallery's spelling of the primary photo when they are the same
  // picture. They routinely differ as strings while naming one file, and the
  // mirror deduplicates on the string — so without this the hero shot is
  // downloaded and stored twice.
  const imageUrl = (rawPrimary && byPhoto.get(imageKey(rawPrimary))) || rawPrimary || images[0] || "";
  if (!imageUrl) issues.push("no image");

  // Colour, in order of how directly the page said it: its own colour field
  // first (kept verbatim — the catalogue shows the store's word for it), then
  // the product title, then the URL slug. The last two are only trusted when
  // they name a colour the catalogue knows, so "Air Force" stays a shoe.
  const colors = [colorFrom(raw.color, name, sourceUrl)].filter(Boolean) as string[];
  const sizes = raw.sizes ?? [];

  return {
    name,
    brand,
    category,
    gender,
    description: raw.description ?? "",
    imageUrl,
    images: images.length ? images : (imageUrl ? [imageUrl] : []),
    colors,
    sizes,
    material: raw.material ?? "",
    price,
    priceOriginal,
    currency,
    sourceUrl,
    strategies: raw.strategies ?? [],
    issues,
    valid: issues.length === 0,
  };
}

/**
 * The colour to file a product under.
 *
 * A colour the page states is kept exactly as written — "Core Black" stays
 * "Core Black", because the catalogue shows the store's own word for it and
 * reads the base colour out of it separately for the swatch and the filter.
 *
 * When the page states none, the title and then the URL's product slug are read
 * for one. Both are guarded by the catalogue's colour vocabulary, so "Nike Air
 * Force 1" contributes nothing while "Wool Runner — Natural Black" contributes
 * Black. Only the last path segment is read: a `/collections/black-friday/`
 * ancestor is a sale, not a colourway.
 */
function colorFrom(stated: string | undefined, name: string, sourceUrl: string): string | undefined {
  // Even a stated colour we cannot classify ("as pictured", "multi") is the
  // store's answer, and a better label than one we made up.
  const said = (stated ?? "").trim();
  if (said) return said;

  const slug = (() => {
    try {
      const last = new URL(sourceUrl).pathname.split("/").filter(Boolean).pop() ?? "";
      return last.replace(/\.(?:html?|aspx?|php|jsp)$/i, "").replace(/[-_]+/g, " ");
    } catch {
      return "";
    }
  })();

  const base = canonicalColor(name) ?? canonicalColor(slug);
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : undefined;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname.replace(/[-_/]+/g, " ");
  } catch {
    return "";
  }
}
