/**
 * Product URLs from the store's sitemap.
 *
 * A sitemap is the shop telling search engines what it sells, so it is the one
 * listing that is meant to be read by a machine — and the one a defended store
 * usually still serves. `/sitemap.xml` answering 200 while the category page
 * answers 403 is the ordinary case, not a lucky one: blocking the sitemap costs
 * a shop its Google traffic, so nobody does it.
 *
 * That makes this the fallback for a blocked or empty crawl. It is also better
 * than the HTML walk where the HTML works at all: no pagination to follow, no
 * anchors to sift, and it lists the whole catalogue rather than the first few
 * pages of a grid.
 *
 * The whole run is bounded to a handful of requests, because it happens inside
 * a serverless function that is already spending its budget on the crawl that
 * failed: robots.txt, at most two sitemap candidates, and at most three child
 * sitemaps out of an index.
 */
import { gunzipSync } from "node:zlib";
import { fetchHtml, fetchBinary } from "./fetch";
import { looksLikeProductPath, isNonProductPath } from "./extract";
import { parseRobots } from "./robots";
import type { ParserFetchSettings } from "./types";

/**
 * Conventional locations, in the order they are worth trying. The first three
 * are the ones every platform ships; the rest are the names a store that does
 * not answer `/sitemap.xml` actually uses — Yoast and WooCommerce publish a
 * products-only file, WordPress core has its own index, and Magento puts the
 * whole thing one directory down. Each is one request that only happens when
 * the names before it gave nothing.
 */
export const CANDIDATES = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap_products_1.xml",
  "/product-sitemap.xml",
  "/wp-sitemap.xml",
  "/sitemap/sitemap-index.xml",
  "/sitemap1.xml",
];

/**
 * The same files, compressed — which is how a large catalogue usually ships
 * them, because the protocol allows it and a 200k-URL sitemap is 90% air.
 * Guessed only in `direct` mode: a scraping provider hands back text, and a
 * gzip stream decoded as text is unrecoverable (see `fetchBinary`).
 */
const GZ_CANDIDATES = ["/sitemap.xml.gz", "/sitemap_index.xml.gz", "/product-sitemap.xml.gz"];

/** Child sitemaps to open out of an index. */
const MAX_CHILDREN = 10;

/** Sitemap documents actually read, robots.txt aside. */
const MAX_DOCUMENTS = 12;

/**
 * Requests spent looking. Documents that answered are counted separately,
 * because a guessed name that 404s is not a document — counting it was what
 * let three wrong guesses use up the whole budget before a real sitemap was
 * ever asked for.
 */
const MAX_REQUESTS = 18;

export function locations(xml: string): string[] {
  const out: string[] = [];
  // `<loc>` holds a bare URL or a CDATA section; WordPress and Magento both
  // ship the latter, and reading only the bare form made their sitemaps look
  // empty rather than unreadable.
  const re = /<loc>\s*(?:<!\[CDATA\[\s*)?([^<\s\]]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1].replace(/&amp;/g, "&"));
  return out;
}

/** Gzip announces itself in its first two bytes, whatever the URL ends with. */
function textFromBytes(bytes: Uint8Array): string | null {
  try {
    const body = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
    return Buffer.from(body).toString("utf8");
  } catch {
    return null;
  }
}

/** An index lists sitemaps; a sitemap lists pages. They need different handling. */
export function isIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/**
 * A sitemap to read, and whether the store named it after its products.
 *
 * The name is evidence, not decoration: `product-sitemap.xml` is the shop
 * declaring that everything inside is a piece for sale, which is worth more
 * than our own reading of a URL's shape.
 */
interface Candidate {
  url: string;
  trusted: boolean;
}

/** Does this sitemap's own name say it lists products? */
export function namesProducts(url: string): boolean {
  return /product/i.test(url);
}

/**
 * A child sitemap worth opening: the ones named after products first, and never
 * the ones that certainly are not (blog posts, pages, collections).
 */
export function rankChild(url: string): number {
  const u = url.toLowerCase();
  if (/product/.test(u)) return 0;
  if (/(?:blog|article|page|collection|marketing)/.test(u)) return 2;
  return 1;
}

async function getText(
  url: string,
  settings: ParserFetchSettings,
  apiKey: string,
): Promise<string | null> {
  // A compressed sitemap has to arrive as bytes; `fetchHtml` would hand back a
  // decoded string that no unzip can recover.
  if (/\.gz(?:\?|$)/i.test(url)) {
    if (settings.provider !== "direct") return null;
    const res = await fetchBinary(url, settings);
    return res.ok && res.bytes ? textFromBytes(res.bytes) : null;
  }
  const res = await fetchHtml(url, settings, apiKey);
  return res.ok && res.html ? res.html : null;
}

/** Sitemap URLs robots.txt points at — the store's own answer, before guessing. */
async function fromRobots(
  origin: string,
  settings: ParserFetchSettings,
  apiKey: string,
): Promise<string[]> {
  const txt = await getText(`${origin}/robots.txt`, settings, apiKey);
  if (!txt) return [];
  return parseRobots(txt).sitemaps;
}

export interface SitemapOptions {
  limit: number;
  /** Wall-clock stop, shared with the crawl that called us. */
  deadline?: number;
}

export interface SitemapResult {
  /** Product URLs found, in sitemap order. */
  urls: string[];
  /** Whether any sitemap could be read at all — the two failures differ. */
  readable: boolean;
  /**
   * How many URLs the sitemaps listed, product-shaped or not. A store whose
   * sitemap is readable but yields no products is a fixable path-test gap;
   * one whose sitemap is refused is not fixable from here at all, and the
   * admin should not have to guess which of the two they are looking at.
   */
  locsSeen: number;
}

/**
 * Product URLs for the store the given URL belongs to. Returns an empty list
 * when there is no readable sitemap — the caller keeps whatever it had.
 */
export async function discoverFromSitemap(
  startUrl: string,
  settings: ParserFetchSettings,
  apiKey: string,
  opts: SitemapOptions,
): Promise<SitemapResult> {
  const nothing: SitemapResult = { urls: [], readable: false, locsSeen: 0 };

  let origin: string;
  let host: string;
  try {
    const u = new URL(startUrl);
    origin = u.origin;
    host = u.hostname.replace(/^www\./, "");
  } catch {
    return nothing;
  }

  const expired = () => !!opts.deadline && Date.now() > opts.deadline;
  if (expired()) return nothing;

  const declared = await fromRobots(origin, settings, apiKey);
  // Gzipped names are guesses worth making only where we can read the answer.
  const guesses = settings.provider === "direct" ? [...CANDIDATES, ...GZ_CANDIDATES] : CANDIDATES;
  const queue: Candidate[] = [
    ...declared.map((u) => ({ url: u, trusted: namesProducts(u) })),
    ...guesses.map((path) => ({ url: `${origin}${path}`, trusted: namesProducts(path) })),
  ];

  const found: string[] = [];
  const seen = new Set<string>();
  const opened = new Set<string>();
  let documents = 0;
  let requests = 0;
  let children = 0;
  let readable = false;
  let locsSeen = 0;

  while (
    queue.length &&
    documents < MAX_DOCUMENTS &&
    requests < MAX_REQUESTS &&
    found.length < opts.limit
  ) {
    if (expired()) break;
    const item = queue.shift()!;
    if (opened.has(item.url)) continue;
    opened.add(item.url);

    // Only ever follow a sitemap on the store's own host — an index can name
    // anything, and a third-party URL there is not the shop's catalogue.
    try {
      if (new URL(item.url).hostname.replace(/^www\./, "") !== host) continue;
    } catch {
      continue;
    }

    const xml = await getText(item.url, settings, apiKey);
    requests++;
    if (!xml || !/<loc>/i.test(xml)) continue;
    documents++;
    readable = true;

    const locs = locations(xml);
    if (isIndex(xml)) {
      const next = locs
        .map((u) => ({ u, rank: rankChild(u) }))
        .filter((c) => c.rank < 2)
        .sort((a, b) => a.rank - b.rank)
        .slice(0, Math.max(0, MAX_CHILDREN - children))
        .map((c) => ({ url: c.u, trusted: namesProducts(c.u) }));
      children += next.length;
      // Children go to the front: an index carries no product URLs itself, and
      // the remaining candidates are guesses we no longer need.
      queue.unshift(...next);
      continue;
    }

    locsSeen += locs.length;
    for (const loc of locs) {
      let path: string;
      try {
        const u = new URL(loc);
        if (u.hostname.replace(/^www\./, "") !== host) continue;
        path = u.pathname;
      } catch {
        continue;
      }
      // A file the store itself named after its products is the store saying
      // what is in it, and that outranks any guess we make from the shape of a
      // URL — which is how a shop addressing pieces as `/shop/<slug>` used to
      // come back as "readable sitemap, no products". The flat refusals still
      // apply: a cart listed in a product sitemap is still not a product.
      const keep = item.trusted ? !isNonProductPath(path) : looksLikeProductPath(path);
      if (!keep) continue;
      const clean = loc.split("#")[0];
      if (seen.has(clean)) continue;
      seen.add(clean);
      found.push(clean);
      if (found.length >= opts.limit) break;
    }
  }

  return { urls: found, readable, locsSeen };
}
