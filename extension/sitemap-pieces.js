/**
 * Sitemaps cut down to what fits in one plan call.
 *
 * A sitemap goes from the worker to the collect tab as a Chrome message, and
 * from the collect tab to our API as a request body. Both have a ceiling.
 * Chrome will not carry an extension message over 64 MB, and Vercel refuses a
 * function body over 4.5 MB before the route sees it. A large store's
 * sitemaps are past both: one that lists every address once per language runs
 * to tens of megabytes. Up to 1.0.12 the worker sent every sitemap it had
 * fetched in one message. On a Farfetch run Chrome refused it, and the run
 * halted with "The collect tab is not reachable" while the tab sat there
 * answering.
 *
 * So each document is cut down to what the planner reads of it: every `<loc>`,
 * plus the `<image:title>` Shopify writes beside a product. These are
 * `locations` and `titles` in src/lib/server/parser/sitemap.ts, and the two
 * must change together. The rest is dropped: hreflang alternates, images,
 * dates. Then it is cut into pieces that each fit one call. A piece keeps its
 * document's address, because the planner treats the name as evidence
 * ("product-sitemap.xml") and records the document as read. Nothing here
 * decides which addresses are products; every one is passed on.
 */

/**
 * Sitemap bytes sent in one plan call. That leaves room under Vercel's 4.5 MB
 * for the rest of the request: robots.txt, and the addresses already seen.
 */
export const PLAN_SITEMAP_BUDGET = 2_000_000;

/** Documents the route reads from one plan call (`MAX_SITEMAPS` in collect/route.ts). */
export const PLAN_SITEMAP_DOCS = 12;

// The same patterns sitemap.ts reads with, so a piece says to the planner
// exactly what its document said.
const LOC = /<loc>\s*(?:<!\[CDATA\[\s*)?([^<\s\]]+)/i;
const LOCS = /<loc>\s*(?:<!\[CDATA\[\s*)?([^<\s\]]+)/gi;
const URL_ENTRY = /<url>([\s\S]*?)<\/url>/gi;
const TITLE = /<image:title>\s*(?:<!\[CDATA\[)?([^<\]]*)/i;

/** UTF-8 length, counted without copying: a title in Cyrillic is two bytes a letter. */
function utf8Bytes(s) {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) n += c > 0x7ff ? 2 : 1;
  }
  return n;
}

/**
 * One fetched sitemap as pieces of at most `budget` bytes, in document order.
 *
 * A document with no `<loc>` at all, such as an HTML page served at a guessed
 * sitemap address, still becomes one empty piece. The planner then records it
 * as read, as it did when the whole text was sent.
 */
export function sitemapPieces(url, xml, budget = PLAN_SITEMAP_BUDGET) {
  const index = /<sitemapindex[\s>]/i.test(xml);
  const tag = index ? "sitemapindex" : "urlset";
  const open = `<${tag}>\n`;
  const close = `</${tag}>`;
  const frame = open.length + close.length;

  // Titles by address, read the way `titles` reads them: one per `<url>`, the
  // last one winning when an address repeats.
  const titles = new Map();
  if (!index) {
    for (const m of xml.matchAll(URL_ENTRY)) {
      const loc = LOC.exec(m[1])?.[1];
      const title = TITLE.exec(m[1])?.[1];
      if (loc && title?.trim()) titles.set(loc, title);
    }
  }

  const pieces = [];
  let entries = [];
  let size = frame;
  const flush = () => {
    const text = open + entries.join("\n") + (entries.length ? "\n" : "") + close;
    pieces.push({ url, xml: text, bytes: utf8Bytes(text) });
    entries = [];
    size = frame;
  };

  for (const m of xml.matchAll(LOCS)) {
    const loc = m[1];
    const title = titles.get(loc);
    const entry = index
      ? `<sitemap><loc>${loc}</loc></sitemap>`
      : `<url><loc>${loc}</loc>${title ? `<image:title>${title}</image:title>` : ""}</url>`;
    const cost = utf8Bytes(entry) + 1;
    if (entries.length && size + cost > budget) flush();
    entries.push(entry);
    size += cost;
  }
  if (entries.length || !pieces.length) flush();
  return pieces;
}

/** Total bytes of the pieces still waiting to be sent. */
export function queuedBytes(queue) {
  return queue.reduce((n, p) => n + p.bytes, 0);
}

/**
 * Take the next plan call's worth of pieces off the front of the queue.
 *
 * At least one piece is always taken, so the queue can never stall on a piece
 * bigger than the budget.
 */
export function takePieces(queue, budget = PLAN_SITEMAP_BUDGET, maxDocs = PLAN_SITEMAP_DOCS) {
  const batch = [];
  let size = 0;
  while (queue.length && batch.length < maxDocs) {
    if (batch.length && size + queue[0].bytes > budget) break;
    const piece = queue.shift();
    size += piece.bytes;
    batch.push({ url: piece.url, xml: piece.xml });
  }
  return batch;
}
