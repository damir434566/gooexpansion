/**
 * Normalise a RawExtract into a ParsedProduct, reusing the shared field helpers
 * so URL imports behave exactly like CSV imports (price/currency/category/gender
 * inference are identical).
 */
import {
  cleanName,
  tidyProductName,
  parsePrice,
  extractCurrencyFromDisplay,
  currencyFromLocale,
  normalizeGtin,
  normalizeCode,
  MAX_PRODUCT_IMAGES,
  matchCategory,
  canonicalColor,
  looksLikeColourLabel,
} from "@/lib/server/product-fields";
import type { RawExtract, ParserSiteConfig, ParsedProduct } from "./types";
import { garmentLabel, matchGarment } from "@/lib/taxonomy/garments";
import { inferStyleKeywords } from "@/lib/taxonomy/styles";
import { genderFromPage } from "@/lib/taxonomy/gender";
import {
  isBuiltInBucket,
  matchSubcategoryLabel,
  resolveSubcategory,
  subcategoryToValue,
  type CategoryGroup,
} from "@/lib/categories";
import { upgradeImageUrl, imageKey } from "./gallery";
import { looksLikeProductPath, isNonProductPath } from "./extract";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

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

export interface NormalizeOptions {
  /**
   * The trailing text this store appends to every page title, worked out by a
   * caller that has seen several of its pages. Subtracted from the name.
   */
  titleSuffix?: string;
  /**
   * The category tree the admin actually runs, from `loadCategoryTree`. Without
   * it the built-in tree is used, which has no "Hoodies", "Long Sleeves" or
   * "Track Jackets" — so a catalogue whose editor split those out got the
   * built-in "Hoodies & Sweatshirts" and "T-Shirts" labels, which its tree then
   * dropped.
   */
  tree?: CategoryGroup[];
}

export function normalizeExtract(
  raw: RawExtract,
  sourceUrl: string,
  config?: ParserSiteConfig | null,
  opts?: NormalizeOptions,
): ParsedProduct {
  const issues: string[] = [];

  const brand = (config?.brandOverride || raw.brand || "").trim();

  // The size suffix goes first (it is about the garment), then the store's
  // furniture (it is about the shop). Both are conservative: anything that
  // cannot be justified is left on the name.
  const name = tidyProductName(cleanName(raw.name ?? ""), {
    host: hostOf(sourceUrl),
    brand,
    titleSuffix: opts?.titleSuffix,
  });
  if (!name) issues.push("missing name");

  const price = parsePrice(raw.price ?? "");
  if (!price) issues.push("missing price");
  const priceOriginal = parsePrice(raw.priceOriginal ?? "");

  // What the page says, and only when it says nothing, what the store is: its
  // country domain or declared language. The inferred answer is labelled, so
  // the import can say "UAH, from the .ua address" instead of passing a guess
  // off as a statement — and so a store with neither still reads as unstated.
  const stated = normalizeCurrency(raw.currency, raw.price);
  const inferred = !stated && price ? currencyFromLocale(sourceUrl, raw.lang) : null;
  const currency = stated || inferred?.code || "";
  if (price && !stated) {
    issues.push(inferred ? `currency not stated — ${inferred.code} from ${inferred.basis}` : "currency not stated");
  }

  // The store's own filing of this piece, outermost crumb first. Two things are
  // read out of it, and both used to be guessed from the name alone or not
  // answered at all: which category the piece belongs to when its name says
  // nothing ("Aurelio"), and which of that category's labels it is.
  const trail = (raw.breadcrumbs ?? []).filter(Boolean).join(" > ");

  // The tree's label for what this piece is: from the name first, which is more
  // specific ("Wool-blend bomber jacket" over a trail's "Jackets"), then from the
  // trail, which answers for a name that classifies nothing ("Aurelio").
  // The garment dictionary first — it knows "tee", "trainers", "beanie" and the
  // Russian names, none of which spell out a label's own words — and the
  // label's words themselves only when the dictionary does not recognise the
  // piece at all. Once it does, a label's words elsewhere in the name are about
  // something else: "Belt Scarf" is a scarf, and reading label words filed it
  // under Belts.
  const tree = opts?.tree;
  const labelValues = subcategoryToValue(tree);
  const labelFor = (text: string) =>
    matchGarment(text) ? garmentLabel(text, labelValues) : matchSubcategoryLabel(text, tree);
  const subLabelFromName = labelFor(name);
  const subLabelFromTrail = trail ? labelFor(trail) : undefined;
  const labelCategory = (label: string | undefined) => {
    const value = label ? labelValues[label] : undefined;
    // The admin can point a tree label at a bucket outside the code's own list.
    // Such a bucket works in the browse filters and is unknown to `Category`, so
    // a label's bucket is only adopted when the code knows it.
    return value && isBuiltInBucket(value) ? (value as ParsedProduct["category"]) : undefined;
  };

  // Category: explicit override → product name/description → URL path hint.
  // Prefer the name-based guess; only fall back to the URL path when the name
  // yields nothing, and to "accessories" only when neither signal matches.
  const category =
    config?.categoryOverride ??
    // The name only. Measured on held-out products, name-only classifies at
    // 92% against 88% when the description is included: descriptions name-drop
    // other garments, and "pairs well with shorts" reads as "is shorts".
    matchCategory(name) ??
    // A label out of the tree, from the name and then from the trail, before any
    // more keyword matching. A tree label is the catalogue's own vocabulary
    // rather than a hint read out of a string, and it carries the category with
    // it: a trail ending in "Blazers" files the piece under blazers, where a
    // keyword pass over the same words would stop at the first thing that looks
    // like outerwear.
    labelCategory(subLabelFromName) ??
    labelCategory(subLabelFromTrail) ??
    matchCategory(trail) ??
    matchCategory(safePath(sourceUrl)) ??
    "accessories";

  // `resolveSubcategory` drops a label the tree does not claim for this
  // category, so a disagreement — an override that says footwear over a name
  // that says bomber jacket — resolves rather than persists.
  const subcategory = resolveSubcategory(category, subLabelFromName ?? subLabelFromTrail, tree);

  // Style, from everything the page said about the piece. The description
  // carries most of it ("a pared-back essential", "utility pockets"), the
  // material some ("linen"), and the label the tree filed it under the rest.
  const styleKeywords = inferStyleKeywords(
    [name, raw.description ?? "", raw.material ?? "", subcategory ?? "", trail].join(" "),
  );

  // Gender: the site config's override, then what the page states — name,
  // address, breadcrumbs, description, strongest first. A page that states
  // nothing is left without one here; the import decides it from the store's
  // setting and the catalogue's history, which this function cannot see.
  const gender =
    config?.genderOverride ??
    genderFromPage({ name, url: sourceUrl, breadcrumbs: trail, description: raw.description })?.gender;

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

  // Same piece, other colours. Resolved and de-duplicated here so the importer
  // receives addresses it can compare against `source_url` directly, and never
  // this page's own address — a product is not a variant of itself.
  //
  // A colour row holds more than colourways: a care-instructions anchor, a
  // size-guide link, a "more colours" page. They are dropped with the same test
  // the collect planner uses to decide what is a product address at all, rather
  // than left to fail a lookup later — an address that reaches the importer is
  // one it will compare against every row it has.
  const variantUrls = [
    ...new Set(
      (raw.variantUrls ?? [])
        .map((u) => absoluteUrl(u, sourceUrl))
        .filter((u): u is string => !!u && u !== sourceUrl)
        .filter((u) => {
          try {
            const candidate = new URL(u);
            // Same store only. The same piece on another retailer's site is not
            // a colourway of this one — it is the same thing sold twice, which
            // belongs in the retailer list, not in a swatch row.
            if (candidate.host !== new URL(sourceUrl).host) return false;
            return looksLikeProductPath(candidate.pathname) && !isNonProductPath(candidate.pathname);
          } catch {
            return false;
          }
        }),
    ),
  ].slice(0, 20);

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
    variantUrls,
    ...(subcategory ? { subcategory } : {}),
    styleKeywords,
    // Validated here rather than trusted: a GTIN that fails its check digit is
    // a digit string the page happened to carry, and matching products on one
    // would link a coat to a phone number's worth of coincidence.
    ...(normalizeGtin(raw.gtin) ? { gtin: normalizeGtin(raw.gtin) } : {}),
    ...(normalizeCode(raw.mpn) ? { mpn: normalizeCode(raw.mpn) } : {}),
    ...(normalizeCode(raw.sku) ? { sku: normalizeCode(raw.sku) } : {}),
    material: raw.material ?? "",
    price,
    priceOriginal,
    currency,
    ...(inferred ? { currencyBasis: inferred.basis } : {}),
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
  // store's answer, and a better label than one we made up — so long as it is a
  // name at all. The storefront readers (Shopify, Woo, Squarespace) reach this
  // without passing through the extractor's own check.
  const said = (stated ?? "").trim();
  if (said && looksLikeColourLabel(said)) return said;

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
