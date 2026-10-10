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

import { colorWordsIn } from "@/lib/server/product-fields";
import { matchGarment } from "@/lib/taxonomy/garments";

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

/** Every image extension at the end of a name: GOAT writes `1111426_00.png.png`. */
const IMAGE_EXTS = /(?:\.(?:jpe?g|png|webp|avif))+$/i;

/**
 * What a store shows, and states in its markup, where a piece has no photo:
 * its placeholder ("no image", "coming soon", `missing.png`), or its own logo
 * or social-share card standing in as `og:image`. Read on the file name — the
 * whole name for the short words, so a "Logo Tee" shot named
 * `logo-tee-black-front.jpg` is still a photo.
 */
const NO_PHOTO_WORDS =
  /(?:^|[-_.])(?:placeholder|no[-_]?(?:image|photo|picture|img)|noimage|nophoto|nopicture|image[-_]?(?:not[-_]?)?(?:available|unavailable)|coming[-_]?soon|missing[-_]?(?:image|photo|picture|product))(?:[-_.]|$)/i;
const NO_PHOTO_NAME =
  /^(?:missing|default|blank|empty|none|null|undefined|logo|(?:store|site|shop|brand)[-_]?logo|og[-_]?(?:image|default)|social[-_]?(?:share|image)|share[-_]?image|default[-_]?(?:image|og|share|product))$/i;

/** Is this address a stand-in for a photo the piece does not have? */
export function isPlaceholderPhoto(url: string): boolean {
  try {
    const path = decodeURIComponent(new URL(url, "https://page.invalid/").pathname).toLowerCase();
    const name = (path.split("/").pop() ?? "").replace(IMAGE_EXTS, "");
    return NO_PHOTO_NAME.test(name) || NO_PHOTO_WORDS.test(name) || /\/placeholders?\//.test(path);
  } catch {
    return false;
  }
}

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

/**
 * WordPress (WooCommerce) writes each upload again at every registered size:
 * `coat.jpg`, `coat-300x300.jpg`, `coat-768x1024.jpg`, and `coat-scaled.jpg`
 * for a large original. Only read under `/wp-content/uploads/`, where the
 * shape is WordPress's own — elsewhere `poster-1x1.jpg` may be a real name.
 */
const WP_UPLOADS = /\/wp-content\/uploads\//i;
const WP_SIZE = /-(?:\d{2,5}x\d{2,5}|scaled)(?=\.[a-z0-9]+$)/i;

/**
 * A path segment that is a blank for the page's script to fill, not part of an
 * address: SSENSE's `__IMAGE_PARAMS__`, or a `{width}` / `{size}`. A page's
 * structured data hands these over as they stand — SSENSE's JSON-LD names its
 * main photo `…/image/upload/__IMAGE_PARAMS__/242232M188005_1.jpg` — and the CDN
 * has no such picture, so the card's main photo was a broken image.
 */
const PLACEHOLDER_SEGMENT = /^(?:__[a-z0-9_]+__|\{[^{}/]*\}|%7b(?:(?!%7d).)*%7d)$/i;
const PLACEHOLDER = /(?:^|\/)(?:__[a-z0-9_]+__|\{[^{}/]*\}|%7b(?:(?!%7d)[^/])*%7d)(?=\/|$)/i;

/** Shopify's lazy-loading blank for a rendition: `photo_{width}x.jpg`. The original has none. */
const SHOPIFY_WIDTH_BLANK = /_(?:\{width\}|%7Bwidth%7D)x(?=\.[a-z0-9]+$)/i;

/**
 * Cloudinary addresses one upload as
 * `…/image/upload/<transformations>/<v123>/<public id>.<ext>`, or with an SEO
 * name as `…/images/<transformations>/<public id>/<name>.<ext>`. Every
 * rendition of a photo — the slide, the 2× retina copy, the zoom — differs only
 * in the transformations: `key_value` pairs joined by commas, chained by
 * slashes, keys from Cloudinary's closed list. Read as plain paths they were six
 * photos of one shot.
 */
const CLOUDINARY_PARAM =
  /^(?:a|ac|af|ar|b|bo|br|c|co|cs|d|dl|dn|dpr|du|e|eo|f|fl|fn|fps|g|h|ki|l|o|p|pg|q|r|so|sp|t|u|vc|vs|w|x|y|z)_[^,/]*$/;

/**
 * Store domains that serve a Cloudinary account under their own name, by that
 * account's name: the photo is one whichever address the page used. SSENSE's
 * structured data names `res.cloudinary.com/ssenseweb`, its pages render
 * `img.ssensemedia.com`.
 */
const CLOUDINARY_DOMAINS: Record<string, string> = {
  "img.ssensemedia.com": "ssenseweb",
};

interface CloudinaryPhoto {
  /** The account: its name on `res.cloudinary.com`, or the domain that serves it. */
  cloud: string;
  /** The address up to the transformations, slash included. */
  head: string;
  /** Transformation segments in order, a placeholder among them as it stands. */
  transforms: string[];
  /** What follows them: version, public id, SEO name, extension. */
  tail: string;
  /** The upload itself — public id without version or extension, lowercased. */
  id: string;
}

function isTransformSegment(segment: string): boolean {
  return PLACEHOLDER_SEGMENT.test(segment) || segment.split(",").every((part) => CLOUDINARY_PARAM.test(part));
}

function cloudinaryPhoto(url: string): CloudinaryPhoto | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const onCloudinary = /(?:^|\.)cloudinary\.com$/.test(host);
  const m =
    u.pathname.match(/^(\/(?:([^/]+)\/)?image\/(?:upload|private)\/)(.+)$/) ??
    u.pathname.match(/^(\/(?:([^/]+)\/)?images\/)(.+)$/);
  if (!m) return null;
  const seo = !/\/image\/(?:upload|private)\/$/.test(m[1]);

  const segments = m[3].split("/");
  let n = 0;
  while (n < segments.length - 1 && isTransformSegment(segments[n])) n++;
  const transforms = segments.slice(0, n);
  let rest = segments.slice(n);
  // `/images/…` is everyone's folder name. It is read as Cloudinary's SEO form
  // only on Cloudinary itself or a domain known to front it, or when what
  // follows is a transformation chain no ordinary folder is named like.
  if (seo && !onCloudinary && !CLOUDINARY_DOMAINS[host] && !transforms.length) return null;
  if (rest[0] && /^v\d+$/.test(rest[0])) rest = rest.slice(1);
  // The SEO form ends in a name for search engines; the upload is before it.
  if (seo) rest = rest.slice(0, -1);
  if (!rest.length || !rest.join("")) return null;

  const cloud = CLOUDINARY_DOMAINS[host] ?? (onCloudinary ? m[2] ?? host : m[2] ? `${host}/${m[2]}` : host);
  const id = decodeURIComponent(rest.join("/")).replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  return {
    cloud: cloud.toLowerCase(),
    head: `${u.origin}${m[1]}`,
    transforms,
    tail: segments.slice(n).join("/") + u.search,
    id,
  };
}

/** Does this address still carry a blank its page was meant to fill? */
export function hasPlaceholder(url: string): boolean {
  try {
    return PLACEHOLDER.test(new URL(url).pathname);
  } catch {
    return PLACEHOLDER.test(url);
  }
}

/**
 * How good a copy of its photo an address is, to choose between two addresses
 * of one photo: the bigger rendition, an address over a blank, and no opinion
 * (0) outside Cloudinary, where `upgradeImageUrl` has already asked for the
 * original and two addresses of one photo are the same picture.
 */
export function renditionRank(url: string): number {
  const c = cloudinaryPhoto(url);
  if (!c) return hasPlaceholder(url) ? -1 : 0;
  if (c.transforms.some((t) => PLACEHOLDER_SEGMENT.test(t))) return -1;
  // A chain can only shrink what the step before it made, so the photo is the
  // size of its smallest step. A chain that sets no size is the full upload.
  let size = Number.MAX_SAFE_INTEGER;
  let dpr = 1;
  for (const segment of c.transforms) {
    let step = 0;
    for (const part of segment.split(",")) {
      const dim = part.match(/^[wh]_(\d+)$/);
      if (dim) step = Math.max(step, Number(dim[1]));
      const density = part.match(/^dpr_(\d+(?:\.\d+)?)$/);
      if (density) dpr = Number(density[1]);
    }
    if (step) size = Math.min(size, step);
  }
  return size === Number.MAX_SAFE_INTEGER ? size : size * dpr;
}

/**
 * An address for a photo its page named only by template, or null when there
 * is none to make.
 *
 * On Cloudinary the blank is the transformation, and the page's own photos
 * show which ones the account serves (an account can refuse any it has not
 * allowed), so the blank takes the chain of its biggest real sibling. With no
 * sibling the blank is dropped: no transformation is the upload itself.
 */
export function fillPhotoTemplate(url: string, siblings: string[] = []): string | null {
  const c = cloudinaryPhoto(url);
  if (!c) return null;
  let chain: string[] = [];
  let best = -1;
  for (const s of siblings) {
    const sc = cloudinaryPhoto(s);
    if (!sc || sc.cloud !== c.cloud) continue;
    const rank = renditionRank(s);
    if (rank > best) {
      best = rank;
      chain = sc.transforms;
    }
  }
  const transforms = c.transforms.flatMap((t) => (PLACEHOLDER_SEGMENT.test(t) ? chain : [t]));
  return `${c.head}${[...transforms, c.tail].join("/")}`;
}

/**
 * One address per photo, keyed by `imageKey`, in the order the photos first
 * appear — the best copy of each (`renditionRank`), and an address the page
 * named by template filled from its siblings or, when nothing can fill it,
 * left out.
 */
export function dedupePhotos(urls: string[]): Map<string, string> {
  const best = new Map<string, string>();
  for (const url of urls) {
    if (!url) continue;
    const key = imageKey(url);
    const held = best.get(key);
    if (held === undefined || renditionRank(url) > renditionRank(held)) best.set(key, url);
  }
  const all = [...best.values()];
  for (const [key, url] of best) {
    if (!hasPlaceholder(url)) continue;
    const filled = fillPhotoTemplate(url, all);
    if (filled && !hasPlaceholder(filled)) best.set(key, filled);
    else best.delete(key);
  }
  return best;
}

/**
 * The addresses in a `srcset`, whole.
 *
 * Split on every comma, a Cloudinary rendition
 * (`…/upload/b_white,c_pad,w_960/photo.jpg 960w`) came apart into
 * `…/upload/b_white`, `c_pad` and `w_960/photo.jpg`. A candidate is the run up
 * to whitespace, and the comma that ends it is the one after its descriptor —
 * or a comma the address itself ends with — as the HTML standard reads it.
 */
export function srcsetUrls(value: string): string[] {
  const out: string[] = [];
  const s = String(value ?? "");
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    const word = s.slice(i, j);
    i = j;
    const url = word.replace(/,+$/, "");
    if (url) out.push(url);
    if (url !== word) continue; // the comma closed it: no descriptor
    let depth = 0;
    while (i < s.length) {
      const ch = s[i++];
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) break;
    }
  }
  return out;
}

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
  u.pathname = u.pathname.replace(SHOPIFY_WIDTH_BLANK, "").replace(RENDITION_SUFFIX, "");
  if (WP_UPLOADS.test(u.pathname)) u.pathname = u.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.[a-z0-9]+$)/i, "");
  // A blank only a Cloudinary address can have filled (`dedupePhotos`);
  // anywhere else it names no picture at all.
  if (PLACEHOLDER.test(u.pathname) && !cloudinaryPhoto(u.toString())) return null;

  if (NON_IMAGE_EXT.test(u.pathname)) return null;
  if (!IMAGE_EXT.test(u.pathname) && !NO_EXTENSION.test(u.pathname)) return null;
  return u.toString();
}

/**
 * Identity of a photo irrespective of rendition — the dedupe key.
 *
 * One photo reaches a page under several addresses, and each one stored is a
 * duplicate on the card:
 *
 *   - Shopify serves every upload both from `cdn.shopify.com/s/files/1/<ids>/`
 *     and from the store's own `/cdn/shop/`; its product JSON uses the first,
 *     the theme's markup the second.
 *   - a size in the name: Shopify's `_600x`, WordPress's `-300x300`/`-scaled`,
 *     Farfetch's `_480`/`_1000`, a retina `@2x`;
 *   - a format: `coat.jpg`, `coat.webp`, and the `coat.jpg.webp` an image
 *     optimiser writes beside it (GOAT's own names end `.png.png`).
 *
 *   - a Cloudinary transformation (`…/upload/w_480,dpr_2.0/<id>.jpg`), or the
 *     template blank in its place: the upload is one photo, whichever account
 *     domain served it.
 *
 * The key drops all of them. A frame number is never touched: `_0010` and
 * `_0017` stay two photos.
 */
export function imageKey(url: string): string {
  const cloudinary = cloudinaryPhoto(url);
  if (cloudinary) return `cloudinary:${cloudinary.cloud}/${cloudinary.id}`;
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, "").toLowerCase();
    let path = decodeURIComponent(u.pathname).toLowerCase();

    const shopify =
      (host === "cdn.shopify.com" && path.match(/^\/s\/files\/(?:\d+\/)+(files|products)\/(.+)$/)) ||
      path.match(/^\/cdn\/shop\/(files|products)\/(.+)$/);
    if (shopify) {
      host = "shopify";
      path = `/${shopify[1]}/${shopify[2]}`;
    }

    path = path.replace(SHOPIFY_WIDTH_BLANK, "").replace(RENDITION_SUFFIX, "");
    if (WP_UPLOADS.test(path)) path = path.replace(WP_SIZE, "");
    path = path
      .replace(/@[23]x(?=\.[a-z0-9]+$)/, "")
      .replace(/\.(?:jpe?g|png)\.(?:webp|avif)$/, ".jpg")
      .replace(IMAGE_EXTS, "");
    if (host.endsWith("farfetch-contents.com")) path = path.replace(/(\d+_\d+)_\d{3,4}$/, "$1");
    return `${host}${path}`;
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Where a photo is served from, for "same host as the main photo": the host,
 * or on Cloudinary the account — `res.cloudinary.com` serves every Cloudinary
 * customer, and one store serves its account from a domain of its own too.
 */
function photoHost(url: string): string {
  const cloudinary = cloudinaryPhoto(url);
  if (cloudinary) return `cloudinary:${cloudinary.cloud}`;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
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
    // On Cloudinary the file is the upload's public id: an SEO name after it is
    // the product's slug on every photo of it — and on the next product's too.
    const cloudinary = cloudinaryPhoto(url);
    const file = cloudinary ? cloudinary.id.split("/").pop() ?? "" : new URL(url).pathname.split("/").pop() ?? "";
    return file
      .replace(IMAGE_EXTS, "")
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
/**
 * Words that describe many pieces, not this one: a colour, a garment, a
 * material or a cut. "Black Leather Jacket" and "Brown Leather Jacket" share
 * `leatherjacket`, and a store names its files after its titles — so a phrase
 * of such words alone matched the jacket beside it in "you may also like".
 */
const DESCRIBING_WORDS = new Set([
  "leather", "suede", "wool", "cotton", "linen", "denim", "nylon", "silk", "cashmere", "fleece",
  "knit", "knitted", "jersey", "canvas", "velvet", "corduroy", "satin", "mesh", "faux", "vegan",
  "oversized", "relaxed", "regular", "slim", "straight", "wide", "cropped", "long", "short",
  "classic", "vintage", "washed", "heavy", "heavyweight", "light", "lightweight", "basic", "essential",
  "logo", "print", "printed", "graphic", "striped", "stripe", "check", "plain", "zip", "hooded",
  "mens", "womens", "unisex", "kids", "new", "sale",
]);

function describesMany(word: string): boolean {
  return DESCRIBING_WORDS.has(word) || colorWordsIn(word).length > 0 || !!matchGarment(word);
}

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
  if (words.length === 1) return words[0].length >= 6 && !describesMany(words[0]) ? words : [];
  const phrases: string[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    // A pair counts only when one of its words is this piece's own.
    if (describesMany(words[i]) && describesMany(words[i + 1])) continue;
    phrases.push(words[i] + words[i + 1]);
  }
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

/**
 * A camera's own file name — `DSC01234`, `IMG_4417`, `_MG_0021`, `P1010001`.
 * Its number counts shots, not products: the next shot of the same session is
 * as likely the next jacket as the back of this one.
 */
const CAMERA_STEM = /^(?:dsc|dscf|dscn|img|mg|imag|dji|gopr|pxl|photo|image)?\d+$|^p\d{7}$/;

function isNumberedFrame(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < FRAME_STEM_MIN) return false;
  if (CAMERA_STEM.test(a) || CAMERA_STEM.test(b)) return false;
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

/**
 * A file named `<code>_<frame>`: SSENSE's `251149M237012_1`, and every store
 * that numbers a piece's shots after its style code. The frame is after the
 * underscore and the code before it is the piece, so a photo of another code is
 * another piece's, however much of the code the two share. SSENSE's codes begin
 * with the season, the brand and the category — every Saucony sneaker of a
 * season starts `251149M237` — and the prefix and numbered-frame tests read
 * that as one shoot: the rail of the brand's other sneakers under the piece
 * came into its gallery.
 */
const CODE_FRAME = /^([a-z0-9]*\d[a-z0-9]*)_\d{1,2}$/;
const CODE_MIN = 6;

function frameCode(url: string): string | null {
  try {
    const cloudinary = cloudinaryPhoto(url);
    const file = cloudinary
      ? cloudinary.id.split("/").pop() ?? ""
      : decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").replace(IMAGE_EXTS, "").toLowerCase();
    const m = file.match(CODE_FRAME);
    return m && m[1].length >= CODE_MIN ? m[1] : null;
  } catch {
    return null;
  }
}

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
  while ((m = srcsetRe.exec(html))) out.push(...srcsetUrls(m[1]));

  // <link rel="preload" as="image"> — browsers preload the gallery's hero shots.
  const preloadRe = /<link\b[^>]*\bas=["']image["'][^>]*>/gi;
  while ((m = preloadRe.exec(html))) {
    const href = m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href) out.push(href[1]);
    const imagesrcset = m[0].match(/\bimagesrcset\s*=\s*["']([^"']+)["']/i);
    if (imagesrcset) out.push(...srcsetUrls(imagesrcset[1]));
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
  //
  // Every extension at the end, not the first: GOAT names a photo
  // `1111426_00.png.png`, and a match stopping at the first `.png` was an
  // address with no picture behind it, filed beside the real one as a second
  // photo.
  const jsonUrlRe =
    /(?:https?:)?(?:\\?\/){2}(?:[^"'\s\\)>]|\\\/)+?(?:\.(?:jpe?g|png|webp|avif))+(?:\?(?:[^"'\s\\)>]|\\\/)*)?/gi;
  while ((m = jsonUrlRe.exec(html))) out.push(m[0].replace(/\\\//g, "/"));

  return out;
}

/**
 * Find additional photos of the same product.
 *
 * `trusted` are the images structured data already gave us — they anchor the
 * search, and are also what a candidate must resemble to be accepted. Returns
 * only the NEW images, in document order; the caller keeps the trusted ones
 * first so the primary photo never changes. A photo already held comes back
 * only as a better copy of itself — the address the page rendered for one its
 * markup named by template, or a bigger Cloudinary rendition — for
 * `dedupePhotos` to put in its place.
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
  const trustedCodes = new Set<string>();
  for (const u of trustedUrls) {
    const host = photoHost(u);
    if (host) trustedHosts.add(host);
    const s = stem(u);
    if (s) trustedStems.push(s);
    const code = frameCode(u);
    if (code) trustedCodes.add(code);
  }

  const { phrases: slugPhrases, codes } = urlIdentity(baseUrl);
  const phrases = [...new Set([...namePhrases(productName), ...slugPhrases])];
  /** Photos held so far, with how good a copy of each (`renditionRank`). */
  const held = new Map<string, number>();
  for (const u of trustedUrls) {
    const key = imageKey(u);
    held.set(key, Math.max(held.get(key) ?? -Infinity, renditionRank(u)));
  }
  const out: string[] = [];

  const candidates = [...collectCandidates(html), ...extra]
    .map((raw) => upgradeImageUrl(raw, baseUrl))
    .filter((u): u is string => !!u);

  for (const url of candidates) {
    const key = imageKey(url);
    const rank = renditionRank(url);
    const had = held.get(key);
    if (had !== undefined) {
      // The same upload is the same photo, so no test below applies to it.
      if (rank > had) {
        held.set(key, rank);
        out.push(url);
      }
      continue;
    }

    const host = photoHost(url);
    let path: string;
    try {
      path = new URL(url).pathname;
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
      if (!host || !trustedHosts.has(host)) continue;
      // A store that names the piece's photos by its code (`<code>_<frame>`):
      // the code decides, and nothing else does — a file named in words is
      // not one of this store's photos of the piece, however many of the
      // piece's words it carries. GOAT's rail is the same model in other
      // colours, `…-retro-high-og-chicago-reimagined.png`.
      const code = frameCode(url);
      if (trustedCodes.size) {
        if (!code || !trustedCodes.has(code)) continue;
      } else if (
        !named &&
        !trustedStems.some(
          (t) =>
            // a numbered frame beside a photo we trust, either by shared prefix…
            (commonPrefixLength(t, s) >= STEM_MATCH_MIN &&
              s.length - commonPrefixLength(t, s) <= STEM_TAIL_MAX) ||
            // …or by being the same filename with a different frame in it
            isNumberedFrame(t, s),
        )
      ) {
        continue;
      }
    }

    held.set(key, rank);
    out.push(url);
  }

  return out;
}
