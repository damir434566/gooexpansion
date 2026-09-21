/**
 * What to collect next, decided on the server, fetched by the browser.
 *
 * The split this module exists for: the extension has the *access* — the
 * admin's address, their cookies, the anti-bot check their browser already
 * passed — and the server has the *judgement*. Nothing here asks the network
 * anything. It is handed the page and the sitemap documents the browser
 * already pulled down, and it answers three questions:
 *
 *   which of these addresses are products worth opening,
 *   how long to wait between opening them,
 *   and which sitemap documents are worth pulling down next round.
 *
 * Being pure is what makes that honest. A planner that could fetch would
 * eventually fetch — one "just robots.txt this once" — from a Vercel address
 * the store has already refused, and the run would fail for a reason the admin
 * could not see. It cannot fetch, so it cannot.
 *
 * Nothing here re-implements the parser's reading of a URL either:
 * `extractProductLinks`, `looksLikeProductPath` and `isNonProductPath` decide
 * what a product address looks like, and `sitemap.ts` decides how a sitemap
 * document is read. This module only sequences them and applies robots.txt.
 */
import { extractProductLinks, looksLikeProductPath, isNonProductPath } from "./extract";
import {
  locations as sitemapLocations,
  isIndex as isSitemapIndex,
  namesProducts,
  rankChild,
  CANDIDATES as SITEMAP_CANDIDATES,
} from "./sitemap";
import { parseRobots, isUrlAllowed, type RobotsRules } from "./robots";

/**
 * The floor under the store's own Crawl-delay.
 *
 * A store asking for nothing does not mean "as fast as you like" — it means it
 * never considered the question. One and a half seconds is slow enough that a
 * run reads as a person browsing rather than as a script, which is the only
 * thing standing between the admin's home address and a block list.
 */
export const MIN_DELAY_MS = 1_500;

/** Sitemap documents worth naming for the next round in one answer. */
const MAX_FETCH_NEXT = 8;

/** Child sitemaps to take out of one index document. */
const MAX_CHILDREN_PER_INDEX = 10;

/** A sitemap document the browser has already fetched. */
export interface FetchedSitemap {
  /** The document's own address — its name is evidence about what is inside. */
  url: string;
  /** Its body, as text. Gzip is the browser's problem, not ours. */
  xml: string;
}

export interface CollectionPlanInput {
  /** The address the admin pointed at: a category, a brand page, a whole store. */
  startUrl: string;
  /** That page's rendered markup, if the browser has opened it. */
  html?: string;
  /** The body of the store's robots.txt, if the browser has fetched it. */
  robotsTxt?: string;
  /** Sitemap documents fetched so far, this round and before. */
  sitemaps?: FetchedSitemap[];
  /** Addresses already planned or visited in earlier rounds. */
  seen?: string[];
  /** How many product addresses the admin asked for, in total. */
  limit: number;
}

export interface CollectionPlan {
  /** Product addresses to open, in order: deduped, same-host, robots-allowed. */
  urls: string[];
  /** The gap to leave between page loads, in milliseconds. */
  delayMs: number;
  /** Sitemap documents worth fetching before the next call. */
  fetchNext: string[];
  /** True when the address the admin pasted is itself a product page. */
  isSingleProduct: boolean;
  /** What robots.txt said, so the screen can show it rather than assert it. */
  robots: {
    /** False when there was no readable robots.txt — then nothing is forbidden. */
    parsed: boolean;
    /** The store's own Crawl-delay, before our floor is applied. */
    crawlDelayMs: number | null;
    /** Sitemaps robots.txt pointed at. */
    sitemaps: string[];
    /** Candidates dropped because robots.txt forbids them. */
    blocked: number;
  };
  /** Addresses the sitemaps listed, product-shaped or not — a readable sitemap
   *  that yields nothing is a different problem from one that is refused. */
  locsSeen: number;
  /** Sitemap documents read this call. */
  sitemapsRead: number;
}

/** The store's host, without `www.`, or "" when the URL is unusable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Strip the fragment: `/a#reviews` and `/a` are one page, and we open it once. */
function canonical(url: string): string {
  return url.split("#")[0];
}

/**
 * Product addresses out of one sitemap document.
 *
 * The trust rule is `sitemap.ts`'s and is kept identical: a document the store
 * named after its products is the store telling us what is inside, which beats
 * our own reading of a URL's shape — so those are filtered only by the flat
 * refusals, and everything else has to look like a product.
 */
function productsFromSitemap(doc: FetchedSitemap, host: string): string[] {
  const trusted = namesProducts(doc.url);
  const out: string[] = [];
  for (const loc of sitemapLocations(doc.xml)) {
    let path: string;
    try {
      const u = new URL(loc);
      if (u.hostname.replace(/^www\./, "") !== host) continue;
      path = u.pathname;
    } catch {
      continue;
    }
    if (trusted ? isNonProductPath(path) : !looksLikeProductPath(path)) continue;
    out.push(canonical(loc));
  }
  return out;
}

/** Child sitemaps worth opening out of an index, best first. */
function childrenFromIndex(doc: FetchedSitemap, host: string): string[] {
  return sitemapLocations(doc.xml)
    .filter((u) => hostOf(u) === host)
    .map((u) => ({ u, rank: rankChild(u) }))
    .filter((c) => c.rank < 2)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_CHILDREN_PER_INDEX)
    .map((c) => c.u);
}

/**
 * Turn what the browser has fetched into what it should open next.
 *
 * Order is deliberate. Sitemap addresses come before addresses scraped out of
 * the page, because a sitemap is the shop listing its own catalogue for
 * machines to read, while an anchor on a category page is our inference — and
 * when the two disagree the shop is right.
 */
export function planCollection(input: CollectionPlanInput): CollectionPlan {
  const host = hostOf(input.startUrl);
  const rules: RobotsRules = parseRobots(input.robotsTxt ?? "");
  const limit = Math.max(1, Math.min(Number(input.limit) || 1, 2_000));

  const docs = input.sitemaps ?? [];
  const seen = new Set((input.seen ?? []).map(canonical));
  const read = new Set(docs.map((d) => d.url));

  const candidates: string[] = [];
  const fetchNext: string[] = [];
  let locsSeen = 0;

  // ── Sitemaps the browser already pulled down ───────────────────────────────
  for (const doc of docs) {
    if (!/<loc>/i.test(doc.xml)) continue;
    if (isSitemapIndex(doc.xml)) {
      for (const child of childrenFromIndex(doc, host)) {
        if (!read.has(child) && !fetchNext.includes(child)) fetchNext.push(child);
      }
      continue;
    }
    locsSeen += sitemapLocations(doc.xml).length;
    candidates.push(...productsFromSitemap(doc, host));
  }

  // ── The page the admin pointed at ──────────────────────────────────────────
  // Its own address counts as a candidate when it is itself a product: pasting
  // a single piece is a legitimate one-item run, not a failed crawl.
  const isSingleProduct = (() => {
    try {
      return looksLikeProductPath(new URL(input.startUrl).pathname);
    } catch {
      return false;
    }
  })();
  if (isSingleProduct) candidates.unshift(canonical(input.startUrl));
  if (input.html) candidates.push(...extractProductLinks(input.html, input.startUrl, limit));

  // ── Sitemaps robots.txt named, for the round after this one ────────────────
  for (const sm of rules.sitemaps) {
    if (hostOf(sm) !== host) continue; // an index can name anything; only ours counts
    if (!read.has(sm) && !fetchNext.includes(sm)) fetchNext.push(sm);
  }

  // Nothing read yet and robots.txt named nothing: fall back to the conventional
  // locations. These are `sitemap.ts`'s list rather than a second copy of it —
  // the browser does the fetching now, but which names are worth trying is the
  // parser's knowledge and stays in one place. A wrong guess is one 404.
  if (!docs.length) {
    try {
      const origin = new URL(input.startUrl).origin;
      for (const path of SITEMAP_CANDIDATES) {
        const guess = `${origin}${path}`;
        if (!read.has(guess) && !fetchNext.includes(guess)) fetchNext.push(guess);
      }
    } catch {
      /* an unusable start URL yields no guesses */
    }
  }

  // ── Filter, in the order the reasons matter ────────────────────────────────
  const urls: string[] = [];
  const taken = new Set<string>();
  let blocked = 0;

  for (const raw of candidates) {
    if (urls.length >= limit) break;
    const url = canonical(raw);
    if (taken.has(url) || seen.has(url)) continue;
    if (hostOf(url) !== host) continue;
    // robots.txt last, so that what it refuses is counted rather than merely
    // absent — an admin looking at "14 of 60 blocked by robots.txt" knows why
    // a run came back small, and "46 products" alone tells them nothing.
    if (!isUrlAllowed(rules, url)) {
      blocked++;
      continue;
    }
    taken.add(url);
    urls.push(url);
  }

  return {
    urls,
    delayMs: Math.max(rules.crawlDelayMs ?? 0, MIN_DELAY_MS),
    fetchNext: fetchNext.slice(0, MAX_FETCH_NEXT),
    isSingleProduct,
    robots: {
      parsed: rules.parsed,
      crawlDelayMs: rules.crawlDelayMs,
      sitemaps: rules.sitemaps,
      blocked,
    },
    locsSeen,
    sitemapsRead: docs.length,
  };
}
