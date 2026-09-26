/**
 * Universal product-field extraction from raw HTML.
 *
 * Strategy, highest precedence first:
 *   1. Per-site recipe regex rules (admin-defined overrides)
 *   2. JSON-LD  (schema.org Product — Farfetch, SSENSE, most luxury e-comm)
 *   3. OpenGraph / product / twitter meta tags
 *   4. Microdata (itemprop=…)
 *
 * No DOM library — pure regex/JSON parsing so it runs in any serverless route.
 */
import type { ParserSiteConfig, RawExtract, ParserRuleField, PageEvidence } from "./types";
import { harvestGalleryImages } from "./gallery";
import { chooseColour } from "./colour-choice";
import {
  canonicalColor,
  extractCurrencyFromDisplay,
  pickSizes,
  specValue,
  compositionFromText,
  MATERIAL_KEYS,
  COLOR_KEYS,
  BRAND_KEYS,
  CODE_KEYS,
  normalizeGtin,
  normalizeCode,
} from "@/lib/server/product-fields";

// ── HTML entity decoding (the handful that show up in product copy) ───────────

export function decodeEntities(input: string): string {
  if (!input) return "";
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&euro;/g, "€")
    .replace(/&pound;/g, "£")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .trim();
}

export function stripTags(input: string): string {
  return decodeEntities(
    (input ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+([.,;:!?])/g, "$1"),
  );
}

// ── Meta tags ─────────────────────────────────────────────────────────────────

type MetaMap = Map<string, string>;

/** Parse every <meta> tag into a { property|name → content } map. */
function parseMetaTags(html: string): MetaMap {
  const map: MetaMap = new Map();
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z_:][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(tag))) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
    }
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    const content = attrs.content;
    if (key && content && !map.has(key)) map.set(key, content);
  }
  return map;
}

/** All values for a repeatable meta key (e.g. multiple og:image). */
function allMeta(html: string, key: string): string[] {
  const out: string[] = [];
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z_:][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(tag))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
    const k = (attrs.property || attrs.name || "").toLowerCase();
    if (k === key.toLowerCase() && attrs.content) out.push(attrs.content);
  }
  return out;
}

// ── JSON-LD ───────────────────────────────────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };

function parseJsonLdBlocks(html: string): JsonObject[] {
  const blocks: JsonObject[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as JsonValue;
      if (Array.isArray(parsed)) parsed.forEach((p) => isObj(p) && blocks.push(p));
      else if (isObj(parsed)) blocks.push(parsed);
    } catch {
      // Some sites embed multiple concatenated objects or trailing commas — skip.
    }
  }
  return blocks;
}

function isObj(v: unknown): v is JsonObject {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function typeIncludes(node: JsonObject, type: string): boolean {
  const t = node["@type"];
  if (typeof t === "string") return t.toLowerCase() === type.toLowerCase();
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && x.toLowerCase() === type.toLowerCase());
  return false;
}

/**
 * A node that describes a piece a shopper can buy: a `Product`, or the
 * `ProductGroup` that stands for one piece in several colours and sizes.
 *
 * `ProductGroup` is what Google has asked stores for since 2024, and a growing
 * share of stores emit it: one group carrying the name, brand and description,
 * and under `hasVariant` one `Product` per colour-and-size. Read as plain
 * Products, that is twelve products on one page — and a page with twelve
 * products is a listing, so the piece was never read as a piece at all.
 */
function isProductNode(node: JsonObject): boolean {
  return typeIncludes(node, "Product") || typeIncludes(node, "ProductGroup");
}

/**
 * Keys under which a Product names the other parts of ITSELF: its variants,
 * the group it is a variant of, its model. What sits there is this piece, not
 * a second one, and is read through the node that owns it.
 */
const OWN_PART_KEYS = new Set(["hasVariant", "isVariantOf", "model"]);

/**
 * Keys under which a Product names a DIFFERENT piece — the "goes well with"
 * and "similar items" a store may describe in its structured data. They count
 * as list items: other products the page mentions, never the page's own.
 */
const RELATED_KEYS = new Set(["isSimilarTo", "isRelatedTo", "isAccessoryOrSparePartFor", "isConsumableFor"]);

/**
 * Breadth-first search across blocks (incl. @graph and ItemList) collecting
 * every Product node in document order. ItemList → itemListElement → item is
 * expanded so listing/category pages yield one node per card.
 */
function findAllProductNodes(blocks: JsonObject[]): JsonObject[] {
  const out: JsonObject[] = [];
  const seen = new Set<JsonObject>();
  const queue: JsonObject[] = [...blocks];
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);

    const product = isProductNode(node);
    if (product) out.push(node);

    // ItemList / ItemPage → itemListElement entries (often { item: Product } or { url })
    const els = node.itemListElement;
    if (Array.isArray(els)) {
      for (const el of els) {
        if (!isObj(el)) continue;
        if (isObj(el.item)) queue.push(el.item);
        else queue.push(el);
      }
    }

    const graph = node["@graph"];
    if (Array.isArray(graph)) graph.forEach((g) => isObj(g) && queue.push(g));
    for (const [k, v] of Object.entries(node)) {
      // A card's variants are that card, not more cards.
      if (product && OWN_PART_KEYS.has(k)) continue;
      if (isObj(v)) queue.push(v);
      else if (Array.isArray(v)) v.forEach((x) => isObj(x) && queue.push(x));
    }
  }
  return out;
}

/**
 * Split Product nodes into the page's own product(s) vs. products that live
 * inside an ItemList (e.g. "you may also like" / "recently viewed" carousels).
 * This lets a product page stay in single-product mode even when it embeds
 * related-product lists — otherwise we'd misread it as a listing.
 */
function partitionProductNodes(blocks: JsonObject[]): { standalone: JsonObject[]; listItems: JsonObject[] } {
  const standalone: JsonObject[] = [];
  const listItems: JsonObject[] = [];
  const seen = new Set<JsonObject>();
  const queue: { node: JsonObject; underList: boolean }[] = blocks.map((b) => ({ node: b, underList: false }));
  while (queue.length) {
    const { node, underList } = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);

    const product = isProductNode(node);
    if (product) (underList ? listItems : standalone).push(node);

    const els = node.itemListElement;
    if (Array.isArray(els)) {
      for (const el of els) {
        if (!isObj(el)) continue;
        queue.push({ node: isObj(el.item) ? el.item : el, underList: true });
      }
    }

    const graph = node["@graph"];
    if (Array.isArray(graph)) graph.forEach((g) => isObj(g) && queue.push({ node: g, underList }));
    for (const [k, v] of Object.entries(node)) {
      if (k === "itemListElement") continue;
      // The piece's own variants are read through the piece. Counted here, a
      // ProductGroup of twelve colour-and-size variants made a product page a
      // "listing" of twelve, and the page's photos, sizes, colour and
      // description were thrown away with the single-product path.
      if (product && OWN_PART_KEYS.has(k)) continue;
      const related = underList || (product && RELATED_KEYS.has(k));
      if (isObj(v)) queue.push({ node: v, underList: related });
      else if (Array.isArray(v)) v.forEach((x) => isObj(x) && queue.push({ node: x, underList: related }));
    }
  }
  return { standalone, listItems };
}

function asString(v: JsonValue | undefined): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  return undefined;
}

/** brand can be a string, { name }, or { @type:"Brand", name }. */
function brandName(v: JsonValue | undefined): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (isObj(v)) return asString(v.name);
  return undefined;
}

/** image can be a string, string[], { url }, or an array of those. */
function imageList(v: JsonValue | undefined): string[] {
  const out: string[] = [];
  const push = (x: JsonValue) => {
    if (typeof x === "string" && x.trim()) out.push(x.trim());
    else if (isObj(x)) {
      const u = asString(x.url) ?? asString(x.contentUrl);
      if (u) out.push(u);
    }
  };
  if (Array.isArray(v)) v.forEach(push);
  else if (v !== undefined) push(v);
  return [...new Set(out)];
}

interface OfferInfo {
  price?: string;
  priceOriginal?: string;
  currency?: string;
}

/** Pull price/currency from Offer | AggregateOffer | Offer[]. */
function offerInfo(v: JsonValue | undefined): OfferInfo {
  const collect = (node: JsonObject): { price?: number; currency?: string; high?: number } => {
    const currency = asString(node.priceCurrency);
    const priceStr =
      asString(node.price) ??
      asString(node.lowPrice) ??
      (isObj(node.priceSpecification) ? asString(node.priceSpecification.price) : undefined);
    const high = asString(node.highPrice);
    return {
      price: priceStr !== undefined ? Number(priceStr) : undefined,
      currency,
      high: high !== undefined ? Number(high) : undefined,
    };
  };

  const nodes: JsonObject[] = [];
  if (Array.isArray(v)) v.forEach((x) => isObj(x) && nodes.push(x));
  else if (isObj(v)) nodes.push(v);
  if (!nodes.length) return {};

  let min = Infinity;
  let max = 0;
  let currency: string | undefined;
  for (const n of nodes) {
    const { price, currency: c, high } = collect(n);
    if (c && !currency) currency = c;
    if (typeof price === "number" && !Number.isNaN(price) && price > 0) {
      min = Math.min(min, price);
      max = Math.max(max, price);
    }
    if (typeof high === "number" && !Number.isNaN(high)) max = Math.max(max, high);
  }
  const result: OfferInfo = { currency };
  if (min !== Infinity) result.price = String(min);
  if (max > 0 && max > (min === Infinity ? 0 : min)) result.priceOriginal = String(max);
  return result;
}

/**
 * The codes a Product node carries: the item's own number, the maker's, the
 * store's.
 *
 * Read from the node and from its offers, because a store that lists one offer
 * per size hangs the GTIN off the offer rather than off the product.
 */
function codesFromNode(node: JsonObject): { gtin: string; mpn: string; sku: string } {
  const gtins: string[] = [];
  const mpns: string[] = [];
  const skus: string[] = [];

  const read = (obj: JsonObject) => {
    for (const key of ["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "ean", "upc"] as const) {
      const value = asString(obj[key]);
      if (value) gtins.push(value);
    }
    const mpn = asString(obj.mpn);
    if (mpn) mpns.push(mpn);
    const sku = asString(obj.sku) ?? asString(obj.productID);
    if (sku) skus.push(sku);
  };

  read(node);
  for (const key of ["offers", "hasVariant"] as const) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach((x) => isObj(x) && read(x));
    else if (isObj(value)) read(value);
  }

  return {
    gtin: gtins.map(normalizeGtin).find(Boolean) ?? "",
    mpn: normalizeCode(mpns[0]),
    sku: normalizeCode(skus[0]),
  };
}

/**
 * The breadcrumb trail out of a `BreadcrumbList`, outermost first.
 *
 * Worth reading from the markup even though the extension also sends the
 * rendered trail: `application/ld+json` survives the content script's strip, so
 * this works on a pasted page and on a server fetch too, where there is no
 * rendered page to read.
 *
 * The last crumb is usually the product itself and is kept — it costs nothing
 * for classification, since the name is matched first anyway.
 */
function breadcrumbsFromJsonLd(html: string): string[] {
  for (const block of parseJsonLdBlocks(html)) {
    const candidates: JsonObject[] = [block];
    const graph = block["@graph"];
    if (Array.isArray(graph)) graph.forEach((g) => isObj(g) && candidates.push(g));

    for (const node of candidates) {
      if (!typeIncludes(node, "BreadcrumbList")) continue;
      const list = node.itemListElement;
      if (!Array.isArray(list)) continue;

      const crumbs: { position: number; name: string }[] = [];
      list.forEach((entry, index) => {
        if (!isObj(entry)) return;
        // `item` is either the thing itself or just its URL; only the former
        // carries a name worth reading.
        const name =
          asString(entry.name) ?? (isObj(entry.item) ? asString(entry.item.name) : undefined);
        if (!name) return;
        const stated =
          typeof entry.position === "number" ? entry.position : Number(asString(entry.position));
        crumbs.push({
          position: Number.isFinite(stated) ? (stated as number) : index + 1,
          name: name.trim(),
        });
      });

      if (crumbs.length) {
        return crumbs
          .sort((a, b) => a.position - b.position)
          .map((c) => c.name)
          .filter(Boolean)
          .slice(0, 12);
      }
    }
  }
  return [];
}

/**
 * The sizes a Product node states, wherever it states them.
 *
 * Until now this returned nothing at all: `sizes: []` was hard-coded in both
 * JSON-LD paths, and the only source of sizes in the whole parser was a per-site
 * recipe rule an admin had written by hand. A store that publishes its sizes as
 * structured data — which is most of them, since Google Shopping asks for it —
 * had them read and thrown away.
 *
 * Four places carry them, and a page uses whichever its platform generates:
 *
 *   size: "M"                        the product is one size
 *   size: ["S","M","L"]              or several
 *   hasVariant: [{ size: "M" }, …]   the schema.org way since 2022
 *   offers: [{ size: "M" }, …]       the older way, still everywhere
 *   additionalProperty: [{ name: "Size", value: "M" }]
 *
 * `size` itself may be a string, a `SizeSpecification` with a name, or a
 * `QuantitativeValue` with a value — all three appear in the wild.
 */
function sizeValues(v: JsonValue | undefined, out: string[]): void {
  if (v === undefined || v === null) return;
  if (Array.isArray(v)) {
    for (const item of v) sizeValues(item as JsonValue, out);
    return;
  }
  if (isObj(v)) {
    const named = asString(v.name) ?? asString(v.value) ?? asString(v.sizeLabel);
    if (named) out.push(named);
    return;
  }
  const str = asString(v);
  if (str) out.push(str);
}

function sizesFromNode(node: JsonObject): string[] {
  const out: string[] = [];

  sizeValues(node.size as JsonValue, out);

  for (const key of ["hasVariant", "offers", "model"] as const) {
    const value = node[key];
    const nodes: JsonObject[] = [];
    if (Array.isArray(value)) value.forEach((x) => isObj(x) && nodes.push(x));
    else if (isObj(value)) nodes.push(value);
    for (const child of nodes) {
      sizeValues(child.size as JsonValue, out);
      // An offer can hang the size off what it offers rather than off itself.
      if (isObj(child.itemOffered)) sizeValues(child.itemOffered.size as JsonValue, out);
    }
  }

  const props = node.additionalProperty;
  const propList: JsonObject[] = [];
  if (Array.isArray(props)) props.forEach((x) => isObj(x) && propList.push(x));
  else if (isObj(props)) propList.push(props);
  for (const prop of propList) {
    const name = (asString(prop.name) ?? "").toLowerCase();
    if (/^(?:size|sizes|talla|taille|größe|grosse|taglia|розмір|размер)$/.test(name)) {
      sizeValues(prop.value as JsonValue, out);
    }
  }

  return [...new Set(out.map((x) => x.trim()).filter(Boolean))];
}

/**
 * The colour a Product node states, wherever it states it.
 *
 * `color` is the documented field, but plenty of feeds put the colourway in an
 * `additionalProperty` row instead ({ name: "Colour", value: "Black" }) or only
 * on the variant that the page is showing (`hasVariant[0].color`). All three
 * are the store's own word for the colour, so all three count.
 */
function colorFromNode(node: JsonObject): string | undefined {
  const direct = asString(node.color) ?? (isObj(node.color) ? asString(node.color.name) : undefined);
  if (direct) return direct;

  const props = node.additionalProperty;
  if (Array.isArray(props)) {
    for (const p of props) {
      if (!isObj(p)) continue;
      const name = (asString(p.name) ?? "").toLowerCase();
      if (name === "color" || name === "colour" || name === "цвет") {
        const value = asString(p.value);
        if (value) return value;
      }
    }
  }

  const variants = node.hasVariant;
  if (Array.isArray(variants)) {
    for (const v of variants) {
      if (!isObj(v)) continue;
      const c = asString(v.color);
      if (c) return c;
    }
  }
  return undefined;
}

function objectsIn(v: JsonValue | undefined): JsonObject[] {
  if (Array.isArray(v)) return v.filter(isObj);
  return isObj(v) ? [v] : [];
}

/** An address reduced to what identifies a page: host, path, and a variant id. */
function pageKey(u: string | undefined): string {
  if (!u) return "";
  try {
    const url = new URL(u);
    const variant = url.searchParams.get("variant") ?? "";
    return `${url.host.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/+$/, "").toLowerCase()}${variant ? `?variant=${variant}` : ""}`;
  } catch {
    return "";
  }
}

function variantUrl(v: JsonObject): string | undefined {
  return (
    asString(v.url) ??
    asString(v["@id"]) ??
    objectsIn(v.offers).map((o) => asString(o.url)).find(Boolean)
  );
}

/**
 * The variant of a group that this page is showing.
 *
 * A variant whose address is the page's own is the answer. Failing that, one
 * on the same path — a store that puts `?variant=` on its variants but not on
 * the link we followed is still showing the first of them. Failing that, the
 * first variant: stores list the default colourway first.
 */
function shownVariant(variants: JsonObject[], pageUrl?: string): JsonObject | undefined {
  if (!variants.length) return undefined;
  const page = pageKey(pageUrl);
  if (page) {
    const exact = variants.find((v) => pageKey(variantUrl(v)) === page);
    if (exact) return exact;
    const path = page.split("?")[0];
    const samePath = variants.find((v) => pageKey(variantUrl(v)).split("?")[0] === path);
    if (samePath) return samePath;
  }
  return variants[0];
}

/**
 * One piece out of a `ProductGroup`: the group says what the piece is, the
 * variant the page shows says which colourway, and the variants in that
 * colourway say which sizes and photos.
 *
 * Photos and sizes come from the shown colour only. The group's other colours
 * are separate cards in the catalogue — linked as colourways, not merged into
 * one gallery with a black coat's photos on the camel one.
 */
/** A JSON-LD reading, plus the photos that belong to the piece's other colours. */
type JsonLdRead = Partial<RawExtract> & { found: boolean; otherColourImages?: string[] };

function rawFromGroup(group: JsonObject, pageUrl?: string): JsonLdRead {
  const variants = objectsIn(group.hasVariant);
  const shown = shownVariant(variants, pageUrl);
  const shownRaw = shown ? rawFromProductNode(shown) : undefined;
  const color = colorFromNode(shown ?? group) ?? colorFromNode(group);
  const sameColour = color
    ? variants.filter((v) => {
        const c = colorFromNode(v);
        return !c || c.toLowerCase() === color.toLowerCase();
      })
    : variants;

  const groupOffers = offerInfo(group.offers);
  const offers = groupOffers.price
    ? groupOffers
    : offerInfo(sameColour.flatMap((v) => objectsIn(v.offers)) as JsonValue);

  const images = [
    ...new Set([...imageList(group.image), ...sameColour.flatMap((v) => imageList(v.image))]),
  ];

  const sizes = [...new Set(sameColour.flatMap((v) => sizesFromNode(v)))];
  const material = asString(group.material) ?? shownRaw?.material;
  const description = asString(group.description) ?? shownRaw?.description;
  const groupCodes = codesFromNode(group);
  const url = (shown && variantUrl(shown)) ?? asString(group.url);

  // The group's other colours, by address — the colourway links a store that
  // switches colours with script never renders as links. They go to the same
  // exact `source_url` lookup as the rendered colour row.
  const otherColours = color
    ? variants
        .filter((v) => {
          const c = colorFromNode(v);
          return !!c && c.toLowerCase() !== color.toLowerCase();
        })
        .map(variantUrl)
        .filter((u): u is string => !!u && /^https?:\/\//.test(u))
    : [];

  // Every variant's photo sits in the JSON-LD text, where the gallery harvester
  // finds it by the same naming as the shown colour's. Named here so it can be
  // kept out: the camel coat's photos are the camel card's.
  const shownImages = new Set(images);
  const otherColourImages = color
    ? variants
        .filter((v) => !sameColour.includes(v))
        .flatMap((v) => imageList(v.image))
        .filter((u) => !shownImages.has(u))
    : [];

  return {
    found: true,
    otherColourImages,
    variantUrls: [...new Set(otherColours)].slice(0, 20),
    name: asString(group.name) ?? shownRaw?.name,
    brand: brandName(group.brand) ?? shownRaw?.brand,
    price: offers.price,
    priceOriginal: offers.priceOriginal,
    currency: offers.currency ?? groupOffers.currency,
    image: images[0],
    images,
    color: color ? decodeEntities(color) : undefined,
    material: material ? decodeEntities(material) : undefined,
    description: description ? stripTags(description) : undefined,
    url: url && /^https?:\/\//.test(url) ? url : undefined,
    sizes: sizes.length ? sizes : sizesFromNode(group),
    gtin: shownRaw?.gtin || groupCodes.gtin,
    // A group's `productGroupID` is the maker's style code on most feeds; the
    // variant's own mpn is more specific when it has one.
    mpn: shownRaw?.mpn || groupCodes.mpn || normalizeCode(asString(group.productGroupID)),
    sku: shownRaw?.sku || groupCodes.sku,
  };
}

/**
 * Extract raw fields from a single schema.org Product (or ProductGroup) node.
 *
 * `pageUrl` picks the variant a group's page is showing; without it the
 * group's first variant is taken.
 */
function rawFromProductNode(node: JsonObject, pageUrl?: string): JsonLdRead {
  if (typeIncludes(node, "ProductGroup")) return rawFromGroup(node, pageUrl);

  // A variant page that names its group: what the variant does not say about
  // itself — usually the brand and the description — the group says for it.
  const group = isObj(node.isVariantOf) ? node.isVariantOf : undefined;
  if (group) {
    const own = rawFromVariant(node);
    const shared = rawFromVariant(group);
    return {
      ...own,
      name: own.name ?? shared.name,
      brand: own.brand ?? shared.brand,
      description: own.description ?? shared.description,
      material: own.material ?? shared.material,
      images: own.images?.length ? own.images : shared.images,
      image: own.image ?? shared.image,
    };
  }
  return rawFromVariant(node);
}

/** The fields one Product node states about itself. */
function rawFromVariant(node: JsonObject): Partial<RawExtract> & { found: boolean } {
  const offers = offerInfo(node.offers);
  const images = imageList(node.image);
  const color = colorFromNode(node);
  const material = asString(node.material);
  const description = asString(node.description);
  const url =
    asString(node.url) ??
    asString(node["@id"]) ??
    (isObj(node.offers) ? asString((node.offers as JsonObject).url) : undefined);

  return {
    found: true,
    name: asString(node.name),
    brand: brandName(node.brand),
    price: offers.price,
    priceOriginal: offers.priceOriginal,
    currency: offers.currency,
    image: images[0],
    images,
    color: color ? decodeEntities(color) : undefined,
    material: material ? decodeEntities(material) : undefined,
    // descriptions are sometimes HTML — strip tags so the catalog stays clean
    description: description ? stripTags(description) : undefined,
    url: url && /^https?:\/\//.test(url) ? url : undefined,
    sizes: sizesFromNode(node),
    ...codesFromNode(node),
  };
}

/** A full RawExtract from a single Product node (json-ld only, no meta merge). */
function nodeToRaw(node: JsonObject): RawExtract {
  const r = rawFromProductNode(node);
  return {
    name: r.name,
    brand: r.brand,
    price: r.price,
    priceOriginal: r.priceOriginal,
    currency: r.currency,
    image: r.image,
    images: r.images ?? [],
    sizes: r.sizes ?? [],
    gtin: r.gtin,
    mpn: r.mpn,
    sku: r.sku,
    color: r.color,
    material: r.material,
    description: r.description,
    url: r.url,
    strategies: ["json-ld"],
  };
}

/** Keep only product-like extracts, deduped by name + url/image. */
function dedupeRaw(list: RawExtract[]): RawExtract[] {
  const out: RawExtract[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const hasData = !!r.name || (!!r.price && !!r.image);
    if (!hasData) continue;
    const key = `${(r.name ?? "").toLowerCase()}::${r.url ?? r.image ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** How much a Product node says, for choosing between two about one piece. */
function richness(r: Partial<RawExtract>): number {
  return (
    (r.price ? 4 : 0) +
    (r.images?.length ? 2 : 0) +
    (r.name ? 1 : 0) +
    (r.brand ? 1 : 0) +
    (r.description ? 1 : 0) +
    (r.sizes?.length ? 1 : 0)
  );
}

/**
 * The page's own product out of its JSON-LD.
 *
 * A page often states its product twice: once from the theme, with offers and
 * photos, and once from a reviews app, with a name and a star rating and
 * nothing else. The fuller statement is taken, and whatever it leaves blank is
 * filled from the others that name the same piece.
 *
 * `allowListFallback` is off when the caller knows it is on a product page (the
 * extension only ever sends those): there, a page with no product of its own in
 * JSON-LD must not borrow one from its "you may also like" list, which would
 * import a stranger's name, price and photos under this page's address.
 */
function fromJsonLd(
  html: string,
  pageUrl?: string,
  allowListFallback = true,
): JsonLdRead {
  const { standalone, listItems } = partitionProductNodes(parseJsonLdBlocks(html));
  if (!standalone.length) {
    const node = allowListFallback ? listItems[0] : undefined;
    if (!node) return { found: false, images: [], sizes: [] };
    return rawFromProductNode(node, pageUrl);
  }

  const reads = standalone.map((n) => rawFromProductNode(n, pageUrl));
  const best = reads.reduce((a, b) => (richness(b) > richness(a) ? b : a));
  const samePiece = (r: Partial<RawExtract>) =>
    !r.name || !best.name || r.name.trim().toLowerCase() === best.name.trim().toLowerCase();
  const merged: JsonLdRead = { ...best };
  for (const r of reads) {
    if (r === best || !samePiece(r)) continue;
    for (const key of ["name", "brand", "price", "priceOriginal", "currency", "image", "color", "material", "description", "url", "gtin", "mpn", "sku"] as const) {
      if (!merged[key] && r[key]) (merged as Record<string, unknown>)[key] = r[key];
    }
    if (!merged.images?.length && r.images?.length) merged.images = r.images;
    if (!merged.sizes?.length && r.sizes?.length) merged.sizes = r.sizes;
  }
  return merged;
}

function fromMeta(html: string): Partial<RawExtract> {
  const meta = parseMetaTags(html);
  const get = (k: string) => meta.get(k.toLowerCase());
  const images = [...new Set([...allMeta(html, "og:image"), ...allMeta(html, "twitter:image")])].filter(Boolean);
  const title = get("og:title");
  const color = get("product:color") || get("product:colour") || get("og:color");
  return {
    name: title ? decodeEntities(title) : undefined,
    brand: get("product:brand") || get("og:brand"),
    price: get("product:price:amount") || get("og:price:amount"),
    currency: get("product:price:currency") || get("og:price:currency"),
    image: images[0],
    images,
    color: color ? decodeEntities(color) : undefined,
    description: (() => {
      const d = get("og:description") || get("description");
      return d ? decodeEntities(d) : undefined;
    })(),
  };
}

/**
 * The page's own heading and title.
 *
 * Neither was read before, which is why product names arrived as
 * "Куртка бомбер, чёрная — MyStore | Купить с доставкой": the name came from
 * `og:title`, and an `og:title` is written for a search result, not a
 * catalogue. An `<h1>` is what the shop prints at the top of the page for a
 * shopper, so it is nearly always the product and nothing else.
 *
 * `<title>` is kept as well, but only as a last resort and as the raw material
 * for working out what this store appends to every page.
 */
function fromHeading(html: string): { h1?: string; h1s: string[]; title?: string } {
  const strip = (frag: string) =>
    decodeEntities(frag.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

  // Every non-empty h1, in order. A header logo is sometimes marked up as one:
  // usually image-only, so it strips to nothing — but on some stores it is the
  // store's name in text ("mowalola"), and taking the first h1 named a leather
  // jacket after the shop. The caller skips the ones that are the store.
  const h1s: string[] = [];
  for (const m of html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)) {
    const text = strip(m[1] ?? "");
    if (text && text.length <= 200) h1s.push(text);
    if (h1s.length >= 5) break;
  }

  const tm = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? strip(tm[1] ?? "") : undefined;

  return { h1: h1s[0], h1s, title: title || undefined };
}

/** Hosts' generic labels: never a store's name. */
const HOST_NOISE = new Set([
  "www", "shop", "store", "eu", "us", "uk", "en", "de", "fr", "it", "es", "ua", "ru", "pl",
  "com", "net", "org", "io", "co", "app", "online", "global", "int",
]);

/**
 * The store's own name as a page might print it where a product name belongs:
 * its `og:site_name` and the words of its host ("mowalola" for mowalola.com).
 * Compared by letters only, so "MOWALOLA" and "Mowalola" are the store.
 */
function storeNames(html: string, baseUrl?: string): Set<string> {
  const key = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const names = new Set<string>();
  const site =
    html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i)?.[1];
  if (site) names.add(key(decodeEntities(site)));
  try {
    if (baseUrl) {
      for (const label of new URL(baseUrl).hostname.split(".")) {
        if (!HOST_NOISE.has(label) && label.length >= 3) names.add(key(label));
      }
    }
  } catch {
    /* no host, no names */
  }
  names.delete("");
  return names;
}

/**
 * The language the page declares for itself: `<html lang>`, then `og:locale`,
 * then a `Content-Language` meta. Used only to guess the currency of a price
 * that no source on the page names (see `currencyFromLocale`).
 */
function pageLanguage(html: string): string | undefined {
  const htmlTag = html.match(/<html\b[^>]*?\blang\s*=\s*["']?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)/i);
  if (htmlTag) return htmlTag[1];
  const meta = parseMetaTags(html);
  const value = meta.get("og:locale") || meta.get("content-language");
  const tag = value?.trim().match(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?/);
  return tag ? tag[0] : undefined;
}

function fromMicrodata(html: string): Partial<RawExtract> {
  const prop = (name: string): string | undefined => {
    // <span itemprop="price" content="49.99"> or text content
    const contentRe = new RegExp(
      `<[^>]*itemprop=["']${name}["'][^>]*\\bcontent=["']([^"']+)["']`,
      "i",
    );
    const cm = html.match(contentRe);
    if (cm) return decodeEntities(cm[1]);
    const textRe = new RegExp(
      `<([a-z0-9]+)[^>]*itemprop=["']${name}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
      "i",
    );
    const tm = html.match(textRe);
    if (tm) {
      const v = stripTags(tm[2]);
      if (v) return v;
    }
    return undefined;
  };
  return {
    gtin: normalizeGtin(prop("gtin13") ?? prop("gtin") ?? prop("gtin12") ?? prop("gtin8")),
    mpn: normalizeCode(prop("mpn")),
    sku: normalizeCode(prop("sku") ?? prop("productID")),
    name: prop("name"),
    brand: prop("brand"),
    price: prop("price"),
    currency: prop("priceCurrency"),
    color: prop("color"),
    material: prop("material"),
  };
}

/**
 * Colour patterns in raw markup, for the stores that carry it nowhere a
 * structured reader can see: on the selected swatch (`data-color="Black"`), in
 * the hydration payload the page ships (`"color":"Black"`), or as a plain
 * "Colour: Black" line in the specification list.
 */
const COLOR_MARKUP: RegExp[] = [
  /\bdata-(?:selected-|product-|variant-)?colou?r(?:-?name)?\s*=\s*["']([^"']{2,40})["']/gi,
  /"colou?r(?:_?name)?"\s*:\s*"([^"]{2,40})"/gi,
  /\bcolou?r\s*:\s*([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё\s/&'-]{1,30})/gi,
];

/**
 * The colour a page states in its markup rather than its structured data.
 *
 * Every candidate has to reduce to a colour the catalogue knows before it is
 * accepted, because each of these patterns also matches things that are not a
 * colourway at all — a CSS value, a theme setting, an analytics field. A match
 * that means nothing to the colour filter is not worth the risk of being wrong,
 * and "Colour: as pictured" is exactly the kind of answer these fields give.
 */
function colorFromHtml(html: string): string | undefined {
  for (const re of COLOR_MARKUP) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = re.exec(html)) && checked < 40) {
      checked++;
      const value = decodeEntities(m[1]).trim();
      if (value && canonicalColor(value)) return value;
    }
  }
  return undefined;
}

/** Apply a single recipe regex rule against the raw HTML. */
function applyRule(html: string, regex: string | undefined): string | undefined {
  if (!regex) return undefined;
  try {
    const re = new RegExp(regex, "i");
    const m = html.match(re);
    if (m) return decodeEntities(m[1] ?? m[0]);
  } catch {
    // Invalid recipe regex — ignore, fall back to generic extraction.
  }
  return undefined;
}

/**
 * Run every strategy and merge with the documented precedence.
 * `config` is the matched per-site recipe (optional).
 */
export function extractProduct(
  html: string,
  config?: ParserSiteConfig | null,
  baseUrl?: string,
  evidence?: PageEvidence,
): RawExtract {
  const strategies: string[] = [];
  const jsonld = fromJsonLd(html, baseUrl, !evidence);
  if (jsonld.found) strategies.push("json-ld");
  const meta = fromMeta(html);
  if (meta.name || meta.price || (meta.images?.length ?? 0) > 0) strategies.push("opengraph");
  const micro = fromMicrodata(html);
  if (micro.name || micro.price) strategies.push("microdata");
  const heading = fromHeading(html);
  if (heading.h1) strategies.push("h1");

  // Recipe regex overrides (highest precedence)
  const ruleVal = (field: ParserRuleField): string | undefined =>
    applyRule(html, config?.rules?.[field]?.regex);
  if (config?.rules && Object.keys(config.rules).length) strategies.push(`recipe:${config.name}`);

  const pick = (...vals: (string | undefined)[]): string | undefined =>
    vals.find((v) => v !== undefined && v !== "");

  const images = [...new Set([...(jsonld.images ?? []), ...(meta.images ?? [])])].filter(Boolean);

  // Sizes, in order of how directly the page said it: a recipe rule an admin
  // wrote, then the store's own structured data, then the size control a
  // shopper clicks.
  //
  // First non-empty wins rather than a merge, because the three spell the same
  // size differently — "40", "EU 40" and "IT 40" are one size in three
  // vocabularies, and merged they become three sizes the product does not have.
  //
  // Only the rendered candidates are filtered. Structured data is the store
  // stating its own sizes and is taken verbatim; the DOM list arrives with the
  // size-guide link and the "Select size" placeholder still in it.
  const sizeRaw = ruleVal("sizes");
  const sizes = sizeRaw
    ? sizeRaw.split(/[,;|]/).map((s) => s.trim()).filter(Boolean)
    : (jsonld.sizes?.length ? jsonld.sizes : pickSizes(evidence?.sizes));

  // Description: the store's own structured copy, then what the page renders —
  // which on a store that hides its description in an accordion is the only
  // full version there is, `og:description` being a truncated marketing line.
  const description = pick(
    ruleVal("description"),
    jsonld.description,
    evidence?.descriptionText,
    meta.description,
  );

  const image = pick(ruleVal("image"), jsonld.image, meta.image, images[0]);
  // The product's name: the first candidate that is not the store's own name.
  // The title the extension read beside the buy button sits after the h1s —
  // on most stores the h1 is the product — and before `og:title`, which is
  // written for search results.
  const shopNames = storeNames(html, baseUrl);
  const isShopName = (v: string) => shopNames.has(v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
  const nameCandidates = [
    ruleVal("name"),
    jsonld.name,
    ...heading.h1s,
    evidence?.titleText,
    meta.name,
    micro.name,
    heading.title,
  ].filter((v): v is string => !!v && !!v.trim());
  const name = nameCandidates.find((v) => !isShopName(v)) ?? nameCandidates[0];
  const brand = pick(
    ruleVal("brand"),
    jsonld.brand,
    meta.brand,
    micro.brand,
    specValue(evidence?.specs, BRAND_KEYS),
    evidence?.brandText,
  );

  // Structured data routinely advertises a single photo for a page that shows
  // a full gallery (an OpenGraph-only page always does — there is one og:image).
  // Harvest the rest from the markup, anchored to what we already trust so the
  // recommendations carousel and page furniture stay out. Trusted images keep
  // their position, so the primary photo never changes.
  let galleryImages: string[] = [];
  if (baseUrl) {
    const anchor = image ? [image, ...images] : images;
    const productName = name ?? "";
    galleryImages = harvestGalleryImages(html, baseUrl, anchor, productName, evidence?.images ?? []);
    if (galleryImages.length) strategies.push("gallery");
  }
  if (jsonld.otherColourImages?.length) {
    const photoKey = (u: string) => u.split(/[?#]/)[0];
    const elsewhere = new Set(jsonld.otherColourImages.map(photoKey));
    galleryImages = galleryImages.filter((u) => !elsewhere.has(photoKey(u)));
  }

  return {
    pageTitle: heading.title,
    name,
    // Brand: structured data first, then the two places a store that treats its
    // designer as a link rather than a property puts it — the spec table, and
    // whatever the page marks as the brand.
    brand,
    // The trail, from the markup and from the rendered page. The markup's own
    // BreadcrumbList wins: it is data rather than a reading of the layout.
    breadcrumbs: (() => {
      const fromMarkup = breadcrumbsFromJsonLd(html);
      return fromMarkup.length ? fromMarkup : (evidence?.breadcrumbs ?? []).slice(0, 12);
    })(),
    // The rendered price is the last resort for both fields, and for opposite
    // reasons. For the amount it is a rescue: a page whose markup states no
    // price at all would otherwise be skipped entirely. For the currency it is
    // the common case rather than the exception — plenty of stores put a bare
    // number in their markup and leave the symbol to the text a shopper reads,
    // and assuming dollars there is how a hryvnia price became a dollar one.
    price: pick(ruleVal("price"), jsonld.price, meta.price, micro.price, evidence?.priceText),
    priceOriginal: jsonld.priceOriginal,
    currency: pick(
      ruleVal("currency"),
      jsonld.currency,
      meta.currency,
      micro.currency,
      evidence?.priceText ? extractCurrencyFromDisplay(evidence.priceText) : undefined,
    ),
    // Not a currency — the page's language, for `normalize` to fall back on
    // when neither the markup nor the rendered price named one.
    lang: pageLanguage(html),
    image,
    images: [
      ...(image && !images.includes(image) ? [image, ...images] : images),
      ...galleryImages,
    ],
    sizes,
    // Colour is worth chasing through every layer: it is what the swatch, the
    // colour filter and half the stylist's vocabulary are built from, and a
    // page that says "Black" anywhere means it.
    // Colour, in order of how directly the page said it. The rendered swatch and
    // the spec row come before the markup scan because they are what the shopper
    // is looking at: `colorFromHtml` mines attributes and inline JSON, which on
    // a page with several colourways can name any of them.
    //
    // Every candidate is kept with where it came from, and `chooseColour` picks
    // the one that is a colour. The first string that merely looked like a
    // name used to win: a swatch thumbnail's alt text is its file name on one
    // store and the product's name on the next ("Emerson"), and both were
    // stored as colours ahead of the "grey/white/leather" the page printed.
    // An extension from before 1.0.3 sends one guess with no origin; it is
    // used only when the new list is absent.
    color: chooseColour(
      [
        { value: ruleVal("color") ?? "", origin: "rule" },
        { value: jsonld.color ?? "", origin: "data" },
        { value: meta.color ?? "", origin: "data" },
        { value: micro.color ?? "", origin: "data" },
        ...(evidence?.colorCandidates?.length
          ? evidence.colorCandidates
          : [{ value: evidence?.colorText ?? "", origin: "legacy" as const }]),
        { value: specValue(evidence?.specs, COLOR_KEYS) ?? "", origin: "line" },
        { value: colorFromHtml(html) ?? "", origin: "markup" },
      ],
      { name, brand },
    )?.value,
    // Material, which until now came from JSON-LD `material` and nowhere else —
    // a field few stores fill, while the page prints "80% wool, 20% polyamide"
    // two lines under the price. Now: the spec table the extension read, then
    // the composition out of the description's own text.
    material: pick(
      ruleVal("material"),
      jsonld.material,
      micro.material,
      // A composition read out of the spec row beats the row itself. The row is
      // whatever the page printed on that line, and a store that renders its
      // whole spec block as one run of text hands over "95% cotton, 5% elastane
      // Care: machine wash" — the blend is the field, the care instruction is
      // the next row that never got its own line.
      compositionFromText(specValue(evidence?.specs, MATERIAL_KEYS)),
      specValue(evidence?.specs, MATERIAL_KEYS),
      compositionFromText(evidence?.descriptionText ?? ""),
      compositionFromText(description ?? ""),
    ),
    description,
    variantUrls: [...new Set([...(evidence?.variantUrls ?? []), ...(jsonld.variantUrls ?? [])])],
    // Codes, for recognising this item on another store's page. The spec table
    // is the fallback: an article number printed in a table is what a store
    // shows when it declares nothing.
    gtin: pick(jsonld.gtin, micro.gtin, normalizeGtin(specValue(evidence?.specs, CODE_KEYS))),
    mpn: pick(jsonld.mpn, micro.mpn),
    sku: pick(jsonld.sku, micro.sku, normalizeCode(specValue(evidence?.specs, CODE_KEYS))),
    strategies,
  };
}

export interface PageProducts {
  /** Number of standalone (non-list) Product nodes — 1 means a product page. */
  standaloneCount: number;
  /** The page's own product(s). */
  standaloneItems: RawExtract[];
  /** Products embedded in an ItemList (listing cards / related products). */
  listItems: RawExtract[];
}

/**
 * Analyse a page: separate its own product(s) from any embedded ItemList. The
 * parse route uses this to choose single-product vs listing mode robustly —
 * a product page with a "related products" carousel stays single.
 */
export function partitionProducts(html: string): PageProducts {
  const { standalone, listItems } = partitionProductNodes(parseJsonLdBlocks(html));
  return {
    standaloneCount: standalone.length,
    standaloneItems: dedupeRaw(standalone.map(nodeToRaw)),
    listItems: dedupeRaw(listItems.map(nodeToRaw)),
  };
}

/**
 * Extract EVERY product embedded in the page (listing / category pages).
 * Returns one RawExtract per schema.org Product node found. A node is kept only
 * if it carries enough to be a real product card (a name, or a price+image).
 */
export function extractProductNodes(html: string): RawExtract[] {
  return dedupeRaw(findAllProductNodes(parseJsonLdBlocks(html)).map(nodeToRaw));
}

// ── Product-link discovery ────────────────────────────────────────────────────

/**
 * Path segments that name a product detail page outright. Matched as whole
 * segments, so `/products/silk-shirt` counts and `/product-care` does not.
 */
const STRONG_SEGMENTS = new Set([
  "product", "products", "prod", "pdp", "pd", "dp", "prd", "item", "items", "shopping", "buy",
]);

/**
 * Segments too short to mean anything on their own — Nike's `/fr/t/…`, Zara's
 * `/p/…`. They only count when the URL also carries a product code, otherwise
 * every one-letter route on the site would look like a product.
 */
const WEAK_SEGMENTS = new Set(["p", "t", "a", "i", "style", "styles", "sku", "article"]);

/**
 * Segments that are never a product. Without this the code heuristic below
 * files `/help/order-12345678` under the catalog.
 */
const NON_PRODUCT_SEGMENTS = new Set([
  "cart", "bag", "basket", "checkout", "login", "signin", "sign-in", "register", "account",
  "my-account", "wishlist", "favourites", "favorites", "help", "faq", "support",
  "customer-service", "about", "about-us", "contact", "contact-us", "careers", "jobs", "press",
  "privacy", "terms", "legal", "cookie", "cookies", "returns", "shipping", "delivery",
  "size-guide", "sizing", "store-locator", "storelocator", "stores", "gift-card", "gift-cards",
  "giftcard", "blog", "news", "magazine", "editorial", "journal", "stories", "search", "sitemap",
  "newsletter", "subscribe", "feedback", "reviews",
]);

/**
 * Does this path segment look like a product code? Covers the shapes stores
 * actually ship: a long digit run (Zara `p04387400`, H&M `productpage.1234567890`,
 * Mytheresa `p00123456`) and a short letter prefix on a digit block
 * (Adidas `EG4958`, Nike `CW2288-111`).
 */
function looksLikeProductCode(segment: string): boolean {
  const token = segment.replace(/\.(?:html?|aspx|jsp|php)$/i, "");
  if (!token) return false;
  if (/\d{5,}/.test(token)) return true;
  return /(?:^|[^a-z0-9])[a-z]{1,3}\d{4,}/i.test(token);
}

/**
 * Sections a shop keeps its pieces under. They are not proof of a product on
 * their own — `/shop/womens` is a section too — but they are what tells a
 * product slug apart from a slug anywhere else on the site.
 */
const SHOP_SECTION_SEGMENTS = new Set([
  "shop", "shops", "store", "boutique", "catalog", "catalogue", "merch",
  "collections", "collection", "category", "categories",
]);

/**
 * Segments that address a SECTION by slug, so the slug right after them is a
 * category and never a piece: Shopify and Squarespace both put collections at
 * `/collections/<slug>` and their products one level deeper.
 */
const SECTION_BY_SLUG_PARENTS = new Set(["collections", "collection", "category", "categories", "c"]);

/**
 * Words a slug uses when it names a part of the shop rather than a thing to
 * buy. A piece is missed by rejecting too much; a "New Arrivals" row filed as a
 * product is a junk row in the catalogue and a model call paid for it — so the
 * guard leans towards rejecting, exactly as the gallery's does.
 */
const LISTING_SLUG_WORDS = new Set([
  "all", "new", "arrivals", "sale", "sales", "clearance", "outlet", "best",
  "bestsellers", "sellers", "selling", "featured", "trending", "shop", "view",
  "browse", "collection", "collections", "category", "categories", "lookbook",
  "gift", "gifts", "guide", "archive", "edit", "edits", "essentials", "index",
]);

/**
 * A slug that reads like the name of one piece: three words or more, long
 * enough to be a name rather than a label, and carrying no word that belongs to
 * a section. Three words is the floor because two-word slugs are overwhelmingly
 * categories (`linen-shirts`, `summer-sale`) and the cost of getting it wrong
 * is a junk row.
 */
function looksLikeProductSlug(segment: string): boolean {
  const token = segment.replace(/\.(?:html?|aspx|jsp|php)$/i, "");
  if (token.length < 12) return false;
  const words = token.split(/[-_]/).filter(Boolean);
  if (words.length < 3) return false;
  if (words.some((w) => LISTING_SLUG_WORDS.has(w))) return false;
  // A slug is words, not a hash or a tracking blob.
  return words.every((w) => /^[a-z0-9]+$/.test(w)) && words.some((w) => /^[a-z]{3,}$/.test(w));
}

/**
 * Does this path point at a product page rather than a category, a filter or a
 * footer link? Four ways to qualify, cheapest first.
 */
export function looksLikeProductPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());
  if (!segments.length) return false;
  if (segments.some((s) => NON_PRODUCT_SEGMENTS.has(s))) return false;

  // 1. An explicit product segment, or the shapes we already relied on:
  //    Farfetch's `-item-…​.aspx`, H&M's `productpage.…`.
  if (segments.some((s) => STRONG_SEGMENTS.has(s) || s.startsWith("productpage"))) return true;
  if (/-item-/i.test(pathname) || /\.aspx$/i.test(pathname)) return true;

  // 2. A weak segment backed by a product code somewhere in the path.
  const hasCode = segments.some(looksLikeProductCode);
  if (hasCode && segments.some((s) => WEAK_SEGMENTS.has(s))) return true;

  // 3. No marker at all, but the last segment is itself a product code —
  //    Zara, Adidas and Mytheresa all address products this way.
  if (looksLikeProductCode(segments[segments.length - 1])) return true;

  // 4. No code anywhere, but a shop section addresses a named piece:
  //    `/shop/nebula-jacket-aurelio`. This is the shape a brand's own store
  //    ships — Squarespace, Webflow, a bespoke build — and without it those
  //    stores answer "the sitemap is readable but holds no products".
  const last = segments[segments.length - 1];
  const parent = segments.length >= 2 ? segments[segments.length - 2] : "";
  if (SECTION_BY_SLUG_PARENTS.has(parent)) return false;
  return segments.slice(0, -1).some((s) => SHOP_SECTION_SEGMENTS.has(s)) && looksLikeProductSlug(last);
}

/**
 * The half of the test that is a flat refusal: a path under a route no shop
 * sells from. A sitemap named after products is the store itself saying what
 * its entries are, so its URLs skip the shape tests above — but not this one,
 * because a store that lists its cart in a product sitemap is still not selling
 * a cart.
 */
export function isNonProductPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());
  if (!segments.length) return true;
  return segments.some((s) => NON_PRODUCT_SEGMENTS.has(s));
}

/**
 * Discover product-page URLs on a listing page. Combines schema.org ItemList
 * URLs with same-host anchors that look like product links — used to "parse
 * each" when the listing doesn't embed full product data.
 *
 * `max` is how many a caller can use. The default is a screenful for the
 * preview path; a catalogue crawl passes its own limit, because a grid showing
 * 120 pieces used to come back as 60 with nothing saying the rest were there.
 */
export function extractProductLinks(html: string, baseUrl: string, max = 60): string[] {
  const urls = new Set<string>();
  let host = "";
  try { host = new URL(baseUrl).hostname.replace(/^www\./, ""); } catch { /* ignore */ }

  // 1. ItemList element urls from JSON-LD — authoritative, no heuristics needed.
  for (const node of findAllProductNodes(parseJsonLdBlocks(html))) {
    const u = (typeof node.url === "string" && node.url) || (typeof node["@id"] === "string" && node["@id"]);
    if (typeof u === "string" && /^https?:\/\//.test(u)) urls.add(u.split("#")[0]);
  }

  // 2. Anchors that look like product pages on the same host.
  const anchorRe = /<a\b[^>]*\bhref=["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    let abs: URL;
    try { abs = new URL(m[1], baseUrl); } catch { continue; }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    if (host && abs.hostname.replace(/^www\./, "") !== host) continue;
    if (!looksLikeProductPath(abs.pathname)) continue;
    urls.add(`${abs.origin}${abs.pathname}`);
    if (urls.size >= max) break;
  }

  return [...urls].slice(0, max);
}
