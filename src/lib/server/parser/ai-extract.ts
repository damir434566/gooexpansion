/**
 * AI fallback for the universal parser.
 *
 * The deterministic extractor (JSON-LD → OpenGraph → microdata) covers most
 * retailers and costs nothing, so it always runs first. But a brand's own
 * Shopify/Webflow/bespoke store often ships no structured data at all, and then
 * we get a name and nothing else. This module hands a stripped-down slice of the
 * page to the OpenAI key already configured for the site and asks for the same
 * fields back as JSON.
 *
 * Two rules keep it cheap and safe:
 *   1. It only fills fields the deterministic pass left EMPTY — real structured
 *      data always wins over a model's reading of the page.
 *   2. It never invents. The prompt requires null for anything not literally on
 *      the page, and any image URL the model returns must appear in the HTML.
 */
import OpenAI from "openai";
import { getOpenAIKey } from "@/lib/server/get-openai-key";
import { harvestGalleryImages } from "./gallery";
import type { RawExtract } from "./types";

/** Cheap, fast, and good at reading messy markup. */
const MODEL = "gpt-4o-mini";

/** Upper bound on the page slice we send (roughly 25k tokens of HTML). */
const MAX_HTML_CHARS = 90_000;

/**
 * Strip a page down to the parts that can carry product facts.
 *
 * Scripts, styles, SVG paths and inline data-URIs are pure token burn — they are
 * the bulk of a modern retail page and contain no prose. What survives is text
 * nodes, image sources and prices.
 */
export function condenseHtml(html: string, maxChars = MAX_HTML_CHARS): string {
  let s = html;

  // Keep JSON-LD out of the strip below — it is the densest source of truth and
  // is tiny; if it were parseable we would not be here, but partial/broken
  // blocks still help the model.
  const jsonLd: string[] = [];
  s = s.replace(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    (_m, body: string) => {
      if (jsonLd.length < 3) jsonLd.push(String(body).slice(0, 4_000));
      return " ";
    },
  );

  s = s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // data: URIs (inline base64 images) — megabytes of noise
    .replace(/(?:src|href)\s*=\s*(["'])data:[^"']*\1/gi, " ")
    // Collapse attributes we never need, keeping src/alt/content/href/itemprop.
    // The lazy-loading attributes stay: on a store that ships a placeholder in
    // `src` and the real photo in `data-src`, stripping them handed the model a
    // page whose every image was a spacer gif — and the gallery is the main
    // thing it is being asked for. `srcset` still goes: it repeats each photo at
    // eight widths, which is pure token burn for no new picture.
    .replace(
      /\s(?:class|style|srcset|sizes|data-(?!src(?!set)|original|image|zoom|large|hires|full)[\w-]+|aria-[\w-]+|id|role|tabindex)\s*=\s*(["'])[\s\S]*?\1/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  const head = jsonLd.length ? `<!-- json-ld -->${jsonLd.join("\n")}\n<!-- /json-ld -->\n` : "";
  const budget = Math.max(1_000, maxChars - head.length);

  // Keep the head (meta/title) and the start of the body — product facts sit
  // near the top on virtually every PDP; trailing footers/recommendations don't.
  return head + (s.length > budget ? s.slice(0, budget) : s);
}

/** Shape the model is asked to return. Every field is nullable by design. */
interface AiFields {
  name?: string | null;
  brand?: string | null;
  price?: string | null;
  priceOriginal?: string | null;
  currency?: string | null;
  images?: string[] | null;
  sizes?: string[] | null;
  color?: string | null;
  material?: string | null;
  description?: string | null;
}

const SYSTEM_PROMPT = `You read raw HTML from an online fashion store and return the product's facts as JSON.

Rules:
- Return ONLY what is literally present in the HTML. If a field is not there, return null. Never guess, never invent, never fill from world knowledge about the brand.
- price and priceOriginal: digits only, e.g. "1290" or "1290.50". No currency symbol, no thousands separator. price is the CURRENT (discounted) price; priceOriginal is the pre-discount price and is null when there is no discount.
- currency: 3-letter ISO code (USD, EUR, GBP, UAH…), inferred from the symbol or explicit code on the page.
- images: absolute or root-relative URLs of EVERY photo of THIS product — the whole gallery, not just the first shot — largest variant available, in page order, max 10. Exclude logos, icons, payment badges, banners and photos of other products.
- name: the product title WITHOUT the brand name prefix.
- description: the product's own copy as plain text, max 800 characters. No marketing boilerplate about shipping or returns.
- sizes: available size labels as shown (e.g. ["XS","S","M"] or ["40","41"]).
- color and material: as stated on the page.

Respond with a single JSON object and nothing else.`;

export interface AiExtractResult {
  fields: AiFields;
  /** Fields the model actually contributed (for admin diagnostics). */
  filled: string[];
  error?: string;
}

/**
 * A product page shows a garment from several angles; one photo means the
 * gallery did not survive the fetch, not that the shoot was one frame. Below
 * this the deterministic result counts as thin even when every other field
 * came back.
 */
const THIN_GALLERY = 2;

/**
 * Is the deterministic result weak enough to be worth an AI call?
 * A page missing name, price or a gallery is the case AI actually rescues.
 */
export function shouldUseAi(raw: RawExtract): boolean {
  return !raw.name || !raw.price || (raw.images?.length ?? 0) < THIN_GALLERY;
}

function asTrimmedString(v: unknown, max = 5_000): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "n/a") return undefined;
  return s.slice(0, max);
}

function asStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = asTrimmedString(item, 500);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Ask the model to read a page. Returns `{ fields: {} }` with an `error` when no
 * key is configured or the call fails — the caller keeps its deterministic
 * result either way, so AI is strictly additive.
 */
export async function aiExtract(
  html: string,
  pageUrl: string,
  opts?: { timeoutMs?: number },
): Promise<AiExtractResult> {
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return { fields: {}, filled: [], error: "OpenAI key not configured (env OPENAI_API_KEY or Settings)." };
  }

  const condensed = condenseHtml(html);
  if (condensed.length < 200) {
    return { fields: {}, filled: [], error: "Page had no readable content to analyse." };
  }

  const client = new OpenAI({ apiKey, timeout: opts?.timeoutMs ?? 45_000, maxRetries: 1 });

  let content: string;
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Page URL: ${pageUrl}\n\nHTML:\n${condensed}`,
        },
      ],
    });
    content = res.choices[0]?.message?.content ?? "";
  } catch (err) {
    return {
      fields: {},
      filled: [],
      error: err instanceof Error ? `AI extraction failed: ${err.message}` : "AI extraction failed",
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { fields: {}, filled: [], error: "AI returned malformed JSON." };
  }

  // Only keep image URLs that genuinely occur in the page — the one field where
  // a hallucination would be invisible until the catalog renders a broken card.
  const rawImages = asStringArray(parsed.images, 10);
  const images = rawImages.filter((u) => {
    if (!/^(https?:)?\/\/|^\//.test(u)) return false;
    const needle = u.replace(/^https?:/, "").slice(0, 120);
    return html.includes(needle);
  });

  const price = asTrimmedString(parsed.price, 40)?.replace(/[^\d.,]/g, "");
  const priceOriginal = asTrimmedString(parsed.priceOriginal, 40)?.replace(/[^\d.,]/g, "");
  const currency = asTrimmedString(parsed.currency, 10)?.toUpperCase();

  const fields: AiFields = {
    name: asTrimmedString(parsed.name, 300),
    brand: asTrimmedString(parsed.brand, 80),
    price: price || undefined,
    priceOriginal: priceOriginal || undefined,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined,
    images: images.length ? images : undefined,
    sizes: asStringArray(parsed.sizes, 40),
    color: asTrimmedString(parsed.color, 60),
    material: asTrimmedString(parsed.material, 300),
    description: asTrimmedString(parsed.description, 2_000),
  };

  const filled = Object.entries(fields)
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : !!v))
    .map(([k]) => k);

  return { fields, filled };
}

/**
 * Merge AI output into a deterministic extract. Structured data always wins;
 * AI only fills holes. Returns a new RawExtract plus the fields it contributed.
 * `pageUrl` resolves and judges the photos it offers (`harvestGalleryImages`).
 */
export function mergeAiIntoRaw(raw: RawExtract, ai: AiFields, pageUrl: string): { raw: RawExtract; used: string[] } {
  const used: string[] = [];
  const next: RawExtract = { ...raw, images: [...(raw.images ?? [])], sizes: [...(raw.sizes ?? [])] };

  const take = <K extends keyof RawExtract>(key: K, value: RawExtract[K] | undefined | null) => {
    if (value === undefined || value === null || value === "") return;
    if (next[key]) return; // deterministic value present — keep it
    next[key] = value;
    used.push(String(key));
  };

  take("name", ai.name ?? undefined);
  take("brand", ai.brand ?? undefined);
  take("price", ai.price ?? undefined);
  take("priceOriginal", ai.priceOriginal ?? undefined);
  take("currency", ai.currency ?? undefined);
  take("color", ai.color ?? undefined);
  take("material", ai.material ?? undefined);
  take("description", ai.description ?? undefined);

  // Photos are the one field AI is allowed to ADD to rather than only fill.
  // Structured data routinely advertises a single photo for a page showing
  // eight, and "one image" is the same failure as "no images" for a catalog —
  // so below a real gallery the model's reading is appended behind whatever the
  // deterministic pass found, which keeps the primary photo where it was. Above
  // it, a working gallery is never diluted.
  //
  // Only beside a photo the page itself stated, and only what the gallery
  // harvester accepts as that photo's own frames. Asked for "every photo of
  // this product" on a GOAT page whose piece had none, the model returned the
  // rail of recommended pieces, and the first of them became the card's main
  // photo. A page with no photo of its own gets none from here, and the model
  // never picks the main photo.
  const own = [raw.image, ...(raw.images ?? [])].filter((u): u is string => !!u);
  if (ai.images?.length && own.length && next.images.length < THIN_GALLERY) {
    const before = next.images.length;
    for (const url of harvestGalleryImages("", pageUrl, own, next.name ?? "", ai.images)) {
      if (!next.images.includes(url)) next.images.push(url);
    }
    if (next.images.length > before) used.push("images");
  }
  if (!next.image && own.length) next.image = own[0];
  if (!next.sizes.length && ai.sizes?.length) {
    next.sizes = ai.sizes;
    used.push("sizes");
  }

  if (used.length) next.strategies = [...(next.strategies ?? []), "ai"];
  return { raw: next, used };
}
