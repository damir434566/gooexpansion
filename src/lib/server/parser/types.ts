/**
 * Types for the universal product-page parser.
 *
 * The parser turns a single product URL (Farfetch, SSENSE, Mr Porter, a brand
 * store, …) into a normalised product the admin can preview and import. It is
 * intentionally site-agnostic: the generic extractor reads JSON-LD / OpenGraph /
 * microdata, and per-site "recipes" only add overrides where a site is unusual.
 */
// A spec row is defined where the helpers that read one live, so the parser
// and the CSV importer cannot end up with two shapes for the same thing.
import type { ColourOrigin } from "./colour-choice";
import type { SpecPair } from "@/lib/server/product-fields";

export type { SpecPair };

import type { Category, Gender } from "@/lib/types";

/**
 * How HTML is fetched. Most luxury sites sit behind anti-bot (Cloudflare,
 * Akamai, DataDome). `direct` works for soft targets; the provider modes route
 * the request through a scraping service that does TLS/JA3 impersonation
 * (curl_cffi-style) and/or a headless browser. `custom` lets the admin point at
 * their own curl_cffi / playwright / cloakbrowser microservice.
 */
export type FetchProvider =
  | "direct"
  | "scrapingbee"
  | "scraperapi"
  | "zenrows"
  | "custom";

export interface ParserFetchSettings {
  provider: FetchProvider;
  /**
   * For `custom`: a URL template. `{url}` is replaced with the URL-encoded
   * target and `{key}` with the API key. Example:
   *   https://my-curl-cffi.fly.dev/fetch?token={key}&url={url}&impersonate=chrome
   */
  endpoint: string;
  /** Ask the provider to render JS in a headless browser (slower, costs more). */
  renderJs: boolean;
  /** Browser fingerprint to impersonate — sent as User-Agent and to providers. */
  impersonate: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

/** A single field-extraction override applied to the raw HTML. */
export interface FieldRule {
  /**
   * A JS regex (without flags) whose FIRST capture group is the value.
   * Applied to the raw HTML. Use for the rare field generic extraction misses.
   */
  regex?: string;
}

export type ParserRuleField =
  | "name"
  | "brand"
  | "price"
  | "currency"
  | "image"
  | "sizes"
  | "color"
  | "material"
  | "description";

/** A per-site recipe: matched by hostname, applies overrides on top of generics. */
export interface ParserSiteConfig {
  id: string;
  name: string;
  /** Bare hostname, e.g. "farfetch.com". Matched via hostname endsWith. */
  domain: string;
  enabled: boolean;
  /** Force a brand for every product from this site (e.g. a single-brand store). */
  brandOverride?: string;
  /** Force a category when the site's data is unreliable. */
  categoryOverride?: Category;
  /** Force a gender (e.g. a womenswear-only retailer). */
  genderOverride?: Gender;
  /** Per-field regex overrides, applied with highest precedence. */
  rules?: Partial<Record<ParserRuleField, FieldRule>>;
  /** Optional per-site fetch override (e.g. this site needs JS rendering). */
  fetch?: Partial<ParserFetchSettings>;
  notes?: string;
}

/**
 * What the collect extension saw on the rendered page, beyond its markup.
 *
 * The extension strips scripts and styles before sending a page — a retail
 * page is megabytes of them — and a single-page storefront keeps half of what
 * we want in exactly that discarded payload. Rather than send it all back,
 * the extension reads the page while it still has it and sends the findings:
 * small, already-resolved, and still only evidence. The server decides what to
 * do with it, the same way it decides about the markup.
 */
export interface PageEvidence {
  /** Image URLs from the live DOM and the page's own data payloads. */
  images?: string[];
  /**
   * The price as the shopper reads it, e.g. "4 000 ₴".
   *
   * On plenty of stores this is the only place the currency is stated at all:
   * the markup carries a bare number and the symbol lives in the rendered text.
   */
  priceText?: string;
  /**
   * Size labels off the size control, loose and unfiltered.
   *
   * A store renders its sizes as buttons, a select or a swatch row, and none of
   * that survives the strip — which is why the parser's only source of sizes
   * used to be a recipe rule written by hand. The list arrives with whatever
   * else lives in that corner of the page ("Select size", the size-guide link)
   * and is filtered by `pickSizes` on the way in.
   */
  sizes?: string[];
  /**
   * The colour this page is showing, in the store's own word for it.
   *
   * Stores state it in the swatch a shopper has selected — an `aria-label`, a
   * `title`, the alt text of a tiny image — or in a line reading "Colour:
   * Charcoal". None of that is structured data, and the colour is what the
   * swatch, the colour filter and half the stylist's vocabulary are built from.
   */
  colorText?: string;
  /**
   * Every string the page offers as its colour, each with where it was read —
   * the selected swatch's attributes, the label beside the swatch row, the
   * store's selected-variant data, loose text in the colour area. Sent by the
   * extension from 1.0.3; the server picks the one that is a colour
   * (`colour-choice.ts`) instead of the extension taking the first that looked
   * like words, which is how a swatch photo's alt "Emerson" became a colour.
   */
  colorCandidates?: { value: string; origin: ColourOrigin }[];
  /**
   * The product's title as the page shows it beside the buy button. On a store
   * whose h1 is its logo and which states no structured name, this is the only
   * place the name is printed ("JORDAN LEATHER JACKET" on mowalola.com).
   */
  titleText?: string;
  /**
   * The store's own product JSON, fetched by the extension from the page's
   * origin — for Shopify, `/products/<handle>.json` with the currency of
   * `/meta.json`. The same record the server reads when it can reach the store
   * itself; the extension reads it because a collected page is never fetched.
   */
  shopify?: { product: unknown; currency?: string };
  /**
   * Addresses of the same piece in other colours, as the colour row links them.
   *
   * This is the catalogue's variant grouping problem stated by the page itself:
   * a colour row is usually a row of links, and each link is this product in
   * another colourway. An address either matches a row we already have or it
   * does not — no guessing about names. Whatever else shares that row (a care
   * link, a size guide) is dropped on the way in by the same test the planner
   * uses to recognise a product address.
   */
  variantUrls?: string[];
  /**
   * The description as the page renders it.
   *
   * Stores put the real copy in an accordion and `og:description` gets a
   * truncated marketing line, so this is often the only full version. Hidden
   * panels count: a collapsed accordion is in the DOM, and `textContent` reads
   * it even when `innerText` will not.
   */
  descriptionText?: string;
  /**
   * The store's own spec table, row by row, in its own language.
   *
   * Composition, care, country, article number — printed as a definition list
   * or a two-column table, and carried by structured data almost never. This is
   * where the material comes from.
   */
  specs?: SpecPair[];
  /**
   * The breadcrumb trail, outermost first: ["Women", "Clothing", "Jackets"].
   *
   * What it answers is the category and the subcategory. The name classifies
   * well when a store names its pieces plainly ("Wool bomber jacket") and not at
   * all when it does not ("Aurelio"), and the trail is the store's own filing of
   * the same piece. A `BreadcrumbList` in JSON-LD survives the strip and is read
   * from the markup; this is for the stores that render a trail and describe it
   * nowhere.
   */
  breadcrumbs?: string[];
  /**
   * The brand as the page prints it, from a marked element or the designer link.
   *
   * Structured data carries it more often than not, which is why brand was only
   * *sometimes* missing — and when it is missing it is usually because the store
   * treats the designer as a link rather than as a property.
   */
  brandText?: string;
}

/** Raw string fields pulled out of a page before normalisation. */
export interface RawExtract {
  name?: string;
  brand?: string;
  price?: string;
  priceOriginal?: string;
  currency?: string;
  /**
   * The language the page declares (`uk-UA`, `pl`). Not evidence about any one
   * price; read only when nothing on the page states a currency.
   */
  lang?: string;
  /**
   * The page's `<title>`, unmodified. Not a name candidate in its own right
   * except as a last resort — it is kept so the store's own repeated furniture
   * can be measured and subtracted.
   */
  pageTitle?: string;
  image?: string;
  images: string[];
  sizes: string[];
  color?: string;
  material?: string;
  description?: string;
  /** Per-product URL (set when extracting from a listing/ItemList). */
  url?: string;
  /** Same piece, other colours — the addresses the page's colour row links to. */
  variantUrls?: string[];
  /** The breadcrumb trail, outermost first, from the markup or the rendered page. */
  breadcrumbs?: string[];
  /** The item's own number (EAN/UPC), verified — the only code safe across stores. */
  gtin?: string;
  /** The maker's part number, unique within a brand. */
  mpn?: string;
  /** The store's own shelf label. Kept for reference, never matched across hosts. */
  sku?: string;
  /** Which strategies contributed at least one field (diagnostics). */
  strategies: string[];
}

/** A fully normalised product ready for preview / import. */
export interface ParsedProduct {
  name: string;
  brand: string;
  category: Category;
  /**
   * The tree's label for what this piece is — "Bomber Jackets", "Sneakers".
   *
   * Absent when nothing in the tree names it. The importer used to write no
   * subcategory at all, so every product filed under whatever its category
   * implied.
   */
  subcategory?: string;
  gender?: Gender;
  description: string;
  imageUrl: string;
  images: string[];
  colors: string[];
  sizes: string[];
  material: string;
  price: number;
  priceOriginal: number;
  currency: string;
  /**
   * Set when `currency` was inferred from the store rather than stated by the
   * page — "the .ua address". Carried to the import so the admin can see why a
   * price was read as hryvnia.
   */
  currencyBasis?: string;
  sourceUrl: string;
  /** Same piece, other colours, for the importer to group this row with. */
  variantUrls: string[];
  /** The item's own number, verified. Matching it across stores is exact. */
  gtin?: string;
  /** The maker's part number; with a brand, good enough to match across stores. */
  mpn?: string;
  /** The store's shelf label, for reference. */
  sku?: string;
  /**
   * The styles the page's own words imply.
   *
   * The importer wrote an empty list for every product it created; the stylist
   * reads this column, so an empty one is a catalogue it cannot reason about
   * past category and colour.
   */
  styleKeywords: string[];
  /** Diagnostics for the admin UI. */
  strategies: string[];
  issues: string[];
  valid: boolean;
}

/**
 * AI-assisted extraction. Uses the site's existing OpenAI key. `auto` (the
 * default) only spends a call when the deterministic pass came back thin —
 * missing name, price or images — which is exactly the case structured-data-less
 * brand stores hit.
 */
export interface ParserAiSettings {
  /** Master switch for the AI fallback. */
  enabled: boolean;
  /** `auto` — only on weak pages; `always` — on every page. */
  mode: "auto" | "always";
  /** Mirror product photos into our Supabase Storage on import. */
  downloadImages: boolean;
}

export const DEFAULT_AI_SETTINGS: ParserAiSettings = {
  enabled: true,
  mode: "auto",
  downloadImages: true,
};

/** Per-product outcome of a crawl run. */
export interface CrawlItemResult {
  url: string;
  status: "imported" | "updated" | "skipped" | "failed";
  productId?: string;
  name?: string;
  reason?: string;
  usedAi?: boolean;
  imagesMirrored?: number;
  /** How many photos the page yielded, before the mirror ran. */
  images?: number;
  /** What happened to the price: the conversion applied, or why none was. */
  priceNote?: string;
  /** Set when the brand came from the product name, not the page. */
  brandNote?: string;
  /** Set when the colour filter came from the name or the photo, not the label. */
  colorNote?: string;
  /** Set when the gender came from the store or the catalogue's history, not the page. */
  genderNote?: string;
  /** What argued for the style tags written. */
  styleNote?: string;
  /** Colour siblings this row was grouped with, if any. */
  variantsLinked?: number;
  /** Set when the page joined an existing product instead of creating one. */
  merged?: boolean;
  /** What recognised that product: a code, or the name and colour. */
  mergedBy?: "code" | "name";
  /** What that merge filled in. */
  mergedFields?: string[];
}

export const DEFAULT_FETCH_SETTINGS: ParserFetchSettings = {
  provider: "direct",
  endpoint: "",
  renderJs: false,
  impersonate: "chrome",
  timeoutMs: 20_000,
};
