/**
 * Types for the universal product-page parser.
 *
 * The parser turns a single product URL (Farfetch, SSENSE, Mr Porter, a brand
 * store, …) into a normalised product the admin can preview and import. It is
 * intentionally site-agnostic: the generic extractor reads JSON-LD / OpenGraph /
 * microdata, and per-site "recipes" only add overrides where a site is unusual.
 */
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
}

/** Raw string fields pulled out of a page before normalisation. */
export interface RawExtract {
  name?: string;
  brand?: string;
  price?: string;
  priceOriginal?: string;
  currency?: string;
  image?: string;
  images: string[];
  sizes: string[];
  color?: string;
  material?: string;
  description?: string;
  /** Per-product URL (set when extracting from a listing/ItemList). */
  url?: string;
  /** Which strategies contributed at least one field (diagnostics). */
  strategies: string[];
}

/** A fully normalised product ready for preview / import. */
export interface ParsedProduct {
  name: string;
  brand: string;
  category: Category;
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
  sourceUrl: string;
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
}

export const DEFAULT_FETCH_SETTINGS: ParserFetchSettings = {
  provider: "direct",
  endpoint: "",
  renderJs: false,
  impersonate: "chrome",
  timeoutMs: 20_000,
};
