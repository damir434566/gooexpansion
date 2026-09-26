/**
 * Fetch one URL and turn it into products — the single pipeline behind both the
 * "Parse URL" screen and the bulk crawler, so the two can never drift apart.
 *
 *   URL → fetch (pluggable anti-bot) → deterministic extract → AI fallback →
 *   normalise → ParsedProduct[]
 *
 * A page resolves into one of three shapes:
 *   - a single product (the common case: a PDP),
 *   - a listing whose cards carry full data (JSON-LD ItemList) — many products,
 *   - a listing that only carries links — `links` is filled so the caller can
 *     walk them.
 */
import type { CategoryGroup } from "@/lib/categories";
import { fetchHtml } from "./fetch";
import { extractProduct, partitionProducts, extractProductLinks } from "./extract";
import { normalizeExtract } from "./normalize";
import { fetchStorefrontProduct } from "./storefront";
import { aiExtract, mergeAiIntoRaw, shouldUseAi } from "./ai-extract";
import { matchSiteConfig, effectiveFetchSettings } from "./configs";
import type {
  PageEvidence,
  ParsedProduct,
  ParserAiSettings,
  ParserFetchSettings,
  ParserSiteConfig,
} from "./types";

export interface ParsePageDiagnostics {
  provider: string;
  status: number;
  htmlLength: number;
  finalUrl: string;
  matchedConfig: { id: string; name: string; domain: string } | null;
  strategies?: string[];
  /** Fields the AI pass contributed, if it ran. */
  aiFields?: string[];
  /** Why AI did not run / failed, when relevant. */
  aiError?: string;
}

export interface ParsePageResult {
  ok: boolean;
  products: ParsedProduct[];
  links: string[];
  isListing: boolean;
  error?: string;
  hint?: string;
  diagnostics: ParsePageDiagnostics;
}

export interface ParsePageOptions {
  fetchSettings: ParserFetchSettings;
  fetchApiKey: string;
  siteConfigs: ParserSiteConfig[];
  aiSettings: ParserAiSettings;
  /** Override the AI decision for this call (admin ticked/unticked the box). */
  useAi?: boolean;
  /**
   * Markup the admin's own browser already has, instead of markup we fetch.
   *
   * This is the free answer to a store that refuses us: their browser passed
   * the anti-bot check we cannot, so the page exists — it is simply on their
   * screen rather than on our server. It is also a *better* source than a
   * server fetch, because it is the RENDERED DOM: lazy-loaded gallery images
   * that only appear after scrolling are real `<img src>` by the time it is
   * copied.
   *
   * Everything downstream is unchanged, which is the point: the same
   * extractor, gallery harvester, colour reading and import run on it.
   */
  html?: string;
  /**
   * What the browser saw that its markup no longer says.
   *
   * Sent with `html` by the collect extension and by nothing else: a server
   * fetch has no rendered page to read, and a pasted page is markup alone. The
   * fields are candidates, not answers — they enter the same extractor at the
   * lowest precedence, behind every structured source.
   */
  evidence?: PageEvidence;
  /**
   * The trailing text this store appends to every page title. Subtracted from
   * the product name — whatever is identical across twenty of a shop's pages
   * is the shop talking, not any one product's name.
   */
  titleSuffix?: string;
  /** The admin's category tree, so subcategories are the labels it actually has. */
  categoryTree?: CategoryGroup[];
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
}

/**
 * Actionable guidance when the upstream blocks us.
 *
 * The free answer comes first, because for a single product it is also the
 * better one: the admin's own browser already passed the check this fetch
 * failed, and what it has on screen is the rendered DOM — a gallery that
 * lazy-loads on scroll arrives whole. A provider is what a *catalogue* needs.
 */
export function blockHint(status: number, provider: string): string | undefined {
  if (status === 403 || status === 401 || status === 429 || status === 503) {
    const paste =
      'This page needs no provider: open it in your own browser and use the "Paste page" panel below — click the "Goo: copy page" bookmarklet on the product page and paste it here.';
    return provider === "direct"
      ? `The site blocked a direct fetch (anti-bot). ${paste} To collect a whole catalogue from this store instead, switch the provider to ScrapingBee/ScraperAPI/ZenRows or your own service in the Fetch & Anti-bot tab, and enable Render JS.`
      : `The provider returned a block. ${paste} Otherwise try enabling Render JS, or check the provider's credit/quota and that the API key is valid.`;
  }
  return undefined;
}

export async function parsePage(url: string, opts: ParsePageOptions): Promise<ParsePageResult> {
  const matched = matchSiteConfig(url, opts.siteConfigs);
  const settings = effectiveFetchSettings(opts.fetchSettings, matched);

  // Shopify, WooCommerce and Squarespace all answer a public JSON address for
  // the same product, and that answer is better than the page in both
  // directions: it carries every photo, every variant and the colour and size
  // options as data, and it is an API endpoint rather than a page, so it is
  // routinely served on a store whose HTML sits behind an anti-bot challenge.
  // Worth a probe before spending a request on markup we would then have to
  // mine — and worth more than that on a store with no structured data, where
  // the markup path pays for a model call. A store that is none of the three
  // answers with a 404 and is remembered, so each guess is paid for once per
  // crawl rather than once per product.
  const pasted = typeof opts.html === "string" && opts.html.trim() ? opts.html : null;

  // Pasted markup skips this: the admin already has the page, so asking the
  // store anything at all would only be a request that can be refused.
  const storefront = pasted ? null : await fetchStorefrontProduct(url, settings, opts.fetchApiKey);
  if (storefront) {
    const product = normalizeExtract(storefront.raw, storefront.sourceUrl, matched, { titleSuffix: opts.titleSuffix, tree: opts.categoryTree });
    return {
      ok: true,
      products: product.name || product.imageUrl ? [product] : [],
      links: [],
      isListing: false,
      diagnostics: {
        provider: settings.provider,
        status: 200,
        htmlLength: storefront.bytes,
        finalUrl: storefront.jsonUrl,
        matchedConfig: matched ? { id: matched.id, name: matched.name, domain: matched.domain } : null,
        strategies: product.strategies,
      },
    };
  }

  const fetched = pasted
    ? { ok: true, status: 200, html: pasted, finalUrl: url, error: undefined }
    : await fetchHtml(url, settings, opts.fetchApiKey);
  const pageUrl = fetched.finalUrl || url;

  const diagnostics: ParsePageDiagnostics = {
    provider: pasted ? "pasted" : settings.provider,
    status: fetched.status,
    htmlLength: fetched.html.length,
    finalUrl: pageUrl,
    matchedConfig: matched ? { id: matched.id, name: matched.name, domain: matched.domain } : null,
  };

  if (!fetched.ok || !fetched.html) {
    return {
      ok: false,
      error: fetched.error ?? "Failed to fetch page",
      hint: blockHint(fetched.status, settings.provider),
      products: [],
      links: [],
      isListing: false,
      diagnostics,
    };
  }

  // Separate the page's own product(s) from embedded ItemList cards so a product
  // page with a "related products" carousel stays single.
  const { standaloneCount, standaloneItems, listItems } = partitionProducts(fetched.html);

  let aiFields: string[] | undefined;
  let aiError: string | undefined;

  /** Single-product path: deterministic extract, then AI for whatever is missing. */
  const single = async (): Promise<ParsedProduct[]> => {
    // pageUrl lets the extractor harvest the gallery out of the markup —
    // relative and protocol-relative image URLs need a base to resolve against.
    let raw = extractProduct(fetched.html, matched, pageUrl, opts.evidence);

    const aiAllowed = opts.useAi ?? opts.aiSettings.enabled;
    const aiWanted = aiAllowed && (opts.aiSettings.mode === "always" || shouldUseAi(raw));
    if (aiWanted) {
      const result = await aiExtract(fetched.html, pageUrl);
      if (result.error) {
        aiError = result.error;
      } else {
        const merged = mergeAiIntoRaw(raw, result.fields);
        raw = merged.raw;
        aiFields = merged.used;
      }
    }

    const prod = normalizeExtract(raw, pageUrl, matched, { titleSuffix: opts.titleSuffix, tree: opts.categoryTree });
    return prod.name || prod.imageUrl ? [prod] : [];
  };

  let products: ParsedProduct[] = [];
  let isListing = false;

  // One piece stated several times — the theme's Product and a reviews app's
  // Product under the same name — is still one piece, not a listing of two.
  const standaloneNames = new Set(
    standaloneItems.map((n) => (n.name ?? "").trim().toLowerCase()).filter(Boolean),
  );

  // The extension only ever sends product pages: the plan picked them. Reading
  // one as a listing takes the first JSON-LD card for the product and discards
  // everything the page itself showed — its photos, sizes, colour, description
  // and the currency printed beside the price.
  if (opts.evidence || standaloneCount === 1 || (standaloneCount >= 2 && standaloneNames.size <= 1)) {
    products = await single();
  } else {
    const items = standaloneCount >= 2 ? standaloneItems : listItems;
    if (items.length >= 2) {
      isListing = true;
      products = items.map((n) => {
        const purl = n.url ? resolveUrl(n.url, pageUrl) : "";
        const prod = normalizeExtract(n, purl || pageUrl, matched, { titleSuffix: opts.titleSuffix, tree: opts.categoryTree });
        // Keep each card's own source URL (empty → import inserts a fresh row
        // instead of all cards colliding on the listing URL).
        prod.sourceUrl = purl;
        return prod;
      });
    } else {
      products = await single();
    }
  }

  // When the page is a listing that didn't embed full product data, surface the
  // product links so the caller can walk them.
  let links: string[] = [];
  if (!isListing && (products.length === 0 || !products[0]?.price)) {
    links = extractProductLinks(fetched.html, pageUrl).filter((u) => u !== pageUrl);
    if (links.length >= 2 && products.length === 0) isListing = true;
  }

  const strategies = isListing ? ["json-ld"] : products[0]?.strategies ?? [];

  return {
    ok: true,
    products,
    links,
    isListing,
    diagnostics: { ...diagnostics, strategies, aiFields, aiError },
  };
}
