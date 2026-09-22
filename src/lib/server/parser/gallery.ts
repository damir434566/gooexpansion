/**
 * Gallery harvesting — find every photo of the product, not just the one the
 * page advertises.
 *
 * Structured data is reliable but thin: OpenGraph carries a single `og:image`,
 * and plenty of stores ship JSON-LD with one photo even when the page shows
 * eight. Measured on a live Allbirds product page, JSON-LD/OG yielded 1 image
 * while the HTML contained the full gallery in plain `<img>` tags.
 *
 * The catalog wants all of them, so this module scrapes the markup — and the
 * whole difficulty is that a retail page is full of images that are NOT this
 * product: a recommendations carousel of other products, nav banners, material
 * icons, payment badges, customer review photos on a third-party host. Adding
 * those is worse than missing a photo, because a wrong image lands in the
 * catalog looking correct.
 *
 * So harvesting is deliberately conservative. A candidate is kept only when it
 * demonstrably belongs to the same product as an image we already trust (from
 * JSON-LD/OpenGraph): same host, and a filename that either resembles a trusted
 * one (shared prefix, or the same name with a different frame number) or names
 * the product itself — by the words of its title, or by the product code the
 * page URL is addressed with. On the Allbirds page that keeps the four real
 * gallery shots (`All-birds_0017/0029/0014/0028` next to the trusted
 * `All-birds_0010`) and rejects all four other-product shots, the sale banner
 * and the material icons.
 *
 * When structured data hands us nothing to anchor to — a store with neither
 * JSON-LD nor og:image — the naming signals run on their own. There is no
 * gallery to lose in that case, only one to find.
 */

/**
 * Query parameters that only ask for a smaller rendition. Beyond the plain
 * `width`/`height` pair, the presets the big image CDNs ship with: Scene7
 * (`wid`/`hei`/`qlt`/`resmode`, used by department stores), Demandware
 * (`sw`/`sh`), Salesforce/Adobe (`dpr`, `scl`) and Akamai (`imwidth`).
 */
const SIZE_PARAMS = [
  "width", "height", "w", "h", "quality", "q", "size", "sw", "sh", "fit", "crop",
  "wid", "hei", "qlt", "resmode", "dpr", "scl", "imwidth", "imdensity", "maxwidth", "maxheight",
];

/**
 * Shopify (and friends) append a rendition suffix right before the extension:
 *   photo_1024x.jpg · photo_600x600_crop_center.jpg · photo_grande.jpg
 * Stripping it yields the original, full-resolution file. Anchored to the end
 * so a size that is genuinely part of the name (`..._PDP_LEFT-2000x2000_ab12`)
 * is left alone.
 */
const RENDITION_SUFFIX =
  /_(?:\d{1,5}x\d{0,5}(?:_crop_[a-z]+)?|pico|icon|thumb|small|compact|medium|large|grande|master|original)(?=\.[a-z0-9]+$)/i;

const IMAGE_EXT = /\.(?:jpe?g|png|webp|avif)$/i;

/**
 * Extensions that are certainly not a photo. Needed because the extension test
 * below had to be loosened: plenty of image CDNs address a photo with no file
 * extension at all — Scene7 (`/is/image/Retailer/SKU_1?$pdp$`), Zara
 * (`/photo?ts=…`), imgix and Cloudinary named transformations. Requiring
 * `.jpg` threw those away, which on those retailers meant throwing away the
 * whole gallery *and* the primary photo the structured data had handed us.
 */
const NON_IMAGE_EXT =
  /\.(?:js|mjs|css|json|xml|html?|php|aspx?|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mov|m3u8|pdf|txt|zip|gz)$/i;

/** A path whose last segment carries no extension at all — a CDN endpoint. */
const NO_EXTENSION = /\/[^/.]+\/?$/;

/**
 * Filename fragments that mark furniture rather than product photography.
 * Matched against the path, so a product genuinely called "Logo Tee" is only at
 * risk if its *filename* says logo — and it would still need to fail the
 * stem test below to be dropped.
 */
const NOISE = /(?:sprite|placeholder|transparent|blank|pixel|spacer|logo|favicon|icon[-_.]|badge|payment|visa|mastercard|paypal|klarna|afterpay|social|instagram|facebook|tiktok|banner|nav[-_.]|menu|header|footer|newsletter|review|rating|star|flag|loader|spinner|swatch|材质)/i;

/** Resolve, upgrade to full resolution, and drop tracking/size noise. */
export function upgradeImageUrl(src: string, baseUrl: string): string | null {
  if (!src) return null;
  let u: URL;
  try {
    u = new URL(src.trim().replace(/&amp;/g, "&"), baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // Ask the CDN for the original rather than the thumbnail the page happened
  // to request. Without this a gallery scraped from `?width=300` markup would
  // be mirrored into our storage at 300px — technically "all the images", and
  // useless for a fashion catalog.
  // Edited as text rather than through `searchParams`, which re-serialises the
  // whole query on any mutation: that turns Scene7's `?$pdp$` preset into
  // `?%24pdp%24=` and asks the CDN for a rendition it does not have.
  if (u.search) {
    const kept = u.search
      .slice(1)
      .split("&")
      .filter((part) => part && !SIZE_PARAMS.includes(part.split("=")[0].toLowerCase()));
    if (kept.length !== u.search.slice(1).split("&").length) u.search = kept.join("&");
  }
  u.pathname = u.pathname.replace(RENDITION_SUFFIX, "");

  if (NON_IMAGE_EXT.test(u.pathname)) return null;
  if (!IMAGE_EXT.test(u.pathname) && !NO_EXTENSION.test(u.pathname)) return null;
  return u.toString();
}

/** Identity of a photo irrespective of rendition — the dedupe key. */
export function imageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(RENDITION_SUFFIX, "").toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Filename reduced to comparable characters: lowercase alphanumerics only.
 * A trailing 32-character hex run is a CDN de-duplication UUID (Shopify appends
 * one when two uploads share a name) and says nothing about the product, so it
 * is removed — otherwise `All-birds_0014_e70e39f1-…` would not read as a
 * sibling of `All-birds_0010`.
 */
function stem(url: string): string {
  try {
    const file = new URL(url).pathname.split("/").pop() ?? "";
    return file
      .replace(IMAGE_EXT, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .replace(/[0-9a-f]{32}$/, "");
  } catch {
    return "";
  }
}

/**
 * Does the filename name this product? Stores that label assets after the
 * product ("…_EasyTote_Cappuccino_Hero") give this signal, and it survives the
 * house template that defeats prefix matching.
 *
 * Matching runs on the name's WORDS, and demands two of them. A sliding
 * character window is too loose: "Men's Cruiser — Shadow Blue (Natural White
 * Sole)" and a different shoe's `Allbirds-Slide-Natural-Black` share the run
 * "enatural", which was enough to pull a stranger's photo into the gallery.
 * Colour and material words recur across a catalog; a product is identified by
 * the combination, not by any single word.
 */
const NAME_TOKEN_MIN = 4;

/**
 * The name's ADJACENT word pairs ("Classic Easy Tote" → classiceasy, easytote).
 * Adjacency is what makes the match a product identity rather than a bag of
 * words: "Classic Easy Tote" and the separate "Classic Tote Insert" accessory
 * share both `classic` and `tote`, so scattered-word matching filed the
 * insert's photos under the tote. No pair of adjacent words collides.
 */
function namePhrases(name: string): string[] {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // A page says "Tree Runners" and names its files `Tree_Runner_…`, so the
    // plural has to be able to match the singular. Dropping a trailing "s"
    // costs nothing: a pair of adjacent words still has to line up.
    .map((t) => (t.length >= 5 && t.endsWith("s") ? t.slice(0, -1) : t))
    .filter((t) => t.length >= NAME_TOKEN_MIN);
  if (words.length === 0) return [];
  // A one-word name ("Cruiser") has no pair — use the word, if it is long
  // enough to identify something on its own.
  if (words.length === 1) return words[0].length >= 6 ? words : [];
  const phrases: string[] = [];
  for (let i = 0; i + 1 < words.length; i++) phrases.push(words[i] + words[i + 1]);
  return [...new Set(phrases)];
}

function matchesProductName(candidateStem: string, phrases: string[]): boolean {
  return phrases.some((p) => candidateStem.includes(p));
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Two filenames of the same length that differ in almost nothing are the same
 * photo shoot: `sku1204551` / `sku1204552`, `pdp-front` / `pdp-front2`.
 *
 * This exists because the prefix test needs ten leading characters to agree,
 * and a CDN that addresses photos as `<sku><frame>` — Scene7 and Demandware
 * both do — puts the difference too early for that: `sku1204551` and a
 * different product's `sku9903341` agree on three. Comparing whole strings
 * position by position tells those two apart while keeping the frames.
 */
const FRAME_DIFF_MAX = 2;
const FRAME_STEM_MIN = 8;

function isNumberedFrame(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < FRAME_STEM_MIN) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && ++diff > FRAME_DIFF_MAX) return false;
  }
  return diff > 0;
}

/**
 * Identity signals carried by the product page's own address.
 *
 * A retailer that names photo files after the SKU — Farfetch answers
 * `/shopping/…-item-27412345.aspx` with `…/27412345_18904371_1000.jpg` — offers
 * nothing else to match on: the filename shares no prefix with the OpenGraph
 * image (different second id) and does not contain the product's name. The
 * page's own slug and product code cover that, and cost one URL parse.
 */
function urlIdentity(pageUrl: string): { phrases: string[]; codes: string[] } {
  try {
    const slug = new URL(pageUrl).pathname
      .split("/")
      .filter(Boolean)
      .slice(-2)
      .join(" ")
      .replace(/\.(?:html?|aspx?|php|jsp)$/i, "");
    // Six digits, not five: a code is matched as a substring of a filename, and
    // a five-digit run collides with dates, timestamps and version numbers
    // often enough to file a banner under a product.
    const codes = [...new Set((slug.toLowerCase().match(/\d{6,}/g) ?? []))];
    return { phrases: namePhrases(slug), codes };
  } catch {
    return { phrases: [], codes: [] };
  }
}

/**
 * How much of a filename must match a trusted image's filename before we
 * believe it is the same product. Ten characters is long enough that
 * `allbirds0010` and `allbirds0029` agree while `allbirds0010` and
 * `a1265026q1allbirdsslide` (a different shoe) do not.
 */
const STEM_MATCH_MIN = 10;

/**
 * A shared prefix only proves kinship when what follows it is a frame number,
 * not another product. Some stores name every asset to a template — Cuyana
 * ships `PDP_2000x2500_<season>_<product>_<colour>_<n>` — so a plain prefix
 * test matched the tote against pouches and charms, which agree for thirteen
 * characters of boilerplate. Requiring the remainder to be short keeps
 * `All-birds_0010` → `All-birds_0017` and rejects
 * `…SU22_EasyTote…` → `…SP26_SystemOrganizerPouch…`.
 */
const STEM_TAIL_MAX = 12;

/** Pull every image reference out of the markup, in document order. */
function collectCandidates(html: string): string[] {
  const out: string[] = [];

  // <img src> / data-src / data-original — lazy-loading libraries use all three.
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html))) {
    const tag = m[0];
    for (const attr of [
      "src", "data-src", "data-original", "data-lazy", "data-image",
      // Zoom viewers keep the full-resolution shot in an attribute of its own —
      // WooCommerce (`data-large_image`), Magento and most jQuery zoom plugins.
      "data-zoom-image", "data-large_image", "data-large", "data-full", "data-hires",
    ]) {
      const a = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i"));
      if (a) out.push(a[1]);
    }
  }

  // CSS background images — carousels built out of <div>s carry the gallery here
  // and have no <img> tag at all.
  const bgRe = /background(?:-image)?\s*:\s*url\((["']?)([^"')]+)\1\)/gi;
  while ((m = bgRe.exec(html))) out.push(m[2]);

  // srcset on <img> and <source>: take every candidate; the largest wins after
  // the rendition suffix and size params are stripped, so order is irrelevant.
  const srcsetRe = /\b(?:data-)?srcset\s*=\s*["']([^"']+)["']/gi;
  while ((m = srcsetRe.exec(html))) {
    for (const part of m[1].split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (url) out.push(url);
    }
  }

  // <link rel="preload" as="image"> — browsers preload the gallery's hero shots.
  const preloadRe = /<link\b[^>]*\bas=["']image["'][^>]*>/gi;
  while ((m = preloadRe.exec(html))) {
    const href = m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href) out.push(href[1]);
    const imagesrcset = m[0].match(/\bimagesrcset\s*=\s*["']([^"']+)["']/i);
    if (imagesrcset) {
      for (const part of imagesrcset[1].split(",")) {
        const url = part.trim().split(/\s+/)[0];
        if (url) out.push(url);
      }
    }
  }

  // Inline JSON blobs (Shopify/Next hydration payloads) reference the gallery
  // as escaped URLs the tag scanners above never see.
  //
  // `\/` has to be allowed for every segment, not just the two after the
  // scheme. A payload that has been JSON-encoded twice — which is how Shopify
  // writes one into a script tag — spells a photo
  // `https:\/\/cdn.shopify.com\/s\/files\/1\/photo.jpg`, and a pattern that
  // stops at the first backslash never reaches the extension that identifies it
  // as an image. It matched the scheme and then quietly found nothing.
  const jsonUrlRe =
    /(?:https?:)?(?:\\?\/){2}(?:[^"'\s\\)>]|\\\/)+?\.(?:jpe?g|png|webp|avif)(?:\?(?:[^"'\s\\)>]|\\\/)*)?/gi;
  while ((m = jsonUrlRe.exec(html))) out.push(m[0].replace(/\\\//g, "/"));

  return out;
}

/**
 * Find additional photos of the same product.
 *
 * `trusted` are the images structured data already gave us — they anchor the
 * search, and are also what a candidate must resemble to be accepted. Returns
 * only the NEW images, in document order; the caller keeps the trusted ones
 * first so the primary photo never changes.
 *
 * `extra` is for candidates the markup does not contain. The collect extension
 * reads the rendered page, so it sees what a virtualised carousel mounted, what
 * a lazy `<img>` finally resolved to, and the URLs inside the hydration payload
 * it strips before sending — none of which survive into the HTML this function
 * is given. They are candidates and nothing more: every one of them goes
 * through the same host and naming tests below, because a page's script data
 * names the recommendations carousel too.
 */
export function harvestGalleryImages(
  html: string,
  baseUrl: string,
  trusted: string[],
  productName = "",
  extra: string[] = [],
): string[] {
  const trustedUrls = trusted
    .map((u) => upgradeImageUrl(u, baseUrl))
    .filter((u): u is string => !!u);

  const trustedHosts = new Set<string>();
  const trustedStems: string[] = [];
  for (const u of trustedUrls) {
    try {
      trustedHosts.add(new URL(u).hostname.replace(/^www\./, ""));
    } catch {
      /* skip */
    }
    const s = stem(u);
    if (s) trustedStems.push(s);
  }

  const { phrases: slugPhrases, codes } = urlIdentity(baseUrl);
  const phrases = [...new Set([...namePhrases(productName), ...slugPhrases])];
  const seen = new Set(trustedUrls.map(imageKey));
  const out: string[] = [];

  const candidates = [...collectCandidates(html), ...extra]
    .map((raw) => upgradeImageUrl(raw, baseUrl))
    .filter((u): u is string => !!u);

  for (const url of candidates) {
    const key = imageKey(url);
    if (seen.has(key)) continue;

    let host: string;
    let path: string;
    try {
      const u = new URL(url);
      host = u.hostname.replace(/^www\./, "");
      path = u.pathname;
    } catch {
      continue;
    }

    const s = stem(url);
    if (!s) continue;

    // Named after the product, or after the code the page URL is addressed by.
    // Either is the product saying "this photo is mine" in its own filename.
    const named = matchesProductName(s, phrases) || codes.some((c) => s.includes(c));

    // Page furniture never carries the product's name, so the noise list only
    // has to judge the candidates that got in on resemblance alone. Applying it
    // to a named match would drop the real photos of a "Star Print Shirt".
    if (!named && NOISE.test(path)) continue;

    if (trustedHosts.size === 0) {
      // Nothing from structured data to anchor to — a store that ships neither
      // JSON-LD nor og:image. There is no gallery to lose here, only one to
      // find, so the naming signal alone decides.
      if (!named) continue;
    } else {
      // A different host is someone else's imagery — review photos, ad pixels,
      // partner badges. The product's gallery is served where its main photo is.
      if (!trustedHosts.has(host)) continue;
      const sibling =
        named ||
        trustedStems.some(
          (t) =>
            // a numbered frame beside a photo we trust, either by shared prefix…
            (commonPrefixLength(t, s) >= STEM_MATCH_MIN &&
              s.length - commonPrefixLength(t, s) <= STEM_TAIL_MAX) ||
            // …or by being the same filename with a different frame in it
            isNumberedFrame(t, s),
        );
      if (!sibling) continue;
    }

    seen.add(key);
    out.push(url);
  }

  return out;
}
