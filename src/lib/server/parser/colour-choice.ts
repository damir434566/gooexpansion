/**
 * Which of the strings a page offers is the colour.
 *
 * A page states its colour in several places at once, and most of them hold
 * something else on some store. The swatch a shopper has selected is a tiny
 * product photo whose `alt` is the product's name ("Emerson" on etnies) or its
 * file name ("A35893_1.jpg"); the swatch row carries badges ("New", "-20%");
 * the label that reads "grey/white/leather" above the row is the answer, and
 * so is the variant the store's own data says is selected. Taking the first
 * string that merely *looked* like words stored "Emerson" as the colour.
 *
 * So every candidate is kept with where it came from, and the choice is:
 *
 *   1. the first from a place that states colours, that names a colour;
 *   2. the first from such a place at all — the store's own word for a
 *      colourway with no colour word in it ("Babymetal Storm") is still its
 *      answer, and the colour filter then comes from the photo;
 *   3. the first from anywhere that names a colour;
 *   4. nothing.
 *
 * Before any of that, strings that are never a colour are dropped: the product
 * name and brand, badges and prices, Shopify's "Default Title", and sizes —
 * the picked size of a size row built from swatches reads exactly like a
 * picked colour.
 */
import { canonicalColor, looksLikeColourLabel, looksLikeSize } from "@/lib/server/product-fields";
import { MULTICOLOUR_WORDS } from "@/lib/taxonomy/colours";

/**
 * Where a candidate came from.
 *
 *   rule    an admin's recipe regex for this store
 *   data    the store's structured data: JSON-LD, Shopify's selected variant
 *   swatch  the selected swatch's own colour attribute (aria-label, title,
 *           data-color, data-value)
 *   label   the "selected colour" label beside the swatch row
 *   line    a "Colour: Charcoal" line or spec-table row
 *   legacy  an older extension's single guess, source unknown
 *   alt     the alt or title of a swatch's thumbnail — often the product name
 *   text    loose text in the colour area — badges, other colourways' names
 *   variant a part of a variant's title ("grey/white/leather / 7") — colour or size
 *   markup  attributes and inline JSON anywhere in the page
 */
export type ColourOrigin =
  | "rule" | "data" | "swatch" | "label" | "line" | "legacy"
  | "alt" | "text" | "variant" | "markup";

export interface ColourCandidate {
  value: string;
  origin: ColourOrigin;
}

/** Places whose job is to state a colour. */
const STATING: ReadonlySet<ColourOrigin> = new Set(["rule", "data", "swatch", "label", "line", "legacy"]);

export const COLOUR_ORIGINS: readonly ColourOrigin[] = [
  "rule", "data", "swatch", "label", "line", "legacy", "alt", "text", "variant", "markup",
];

/** Badge and placeholder text that sits where a colour does. */
const NOT_A_COLOUR =
  /^(?:new|new in|just in|sale|on sale|sold out|out of stock|in stock|low stock|back in stock|coming soon|pre ?order|best ?seller|bestseller|top seller|limited|limited edition|exclusive|online exclusive|online only|hot|trending|popular|last chance|final sale|clearance|default|default title|standard|one colou?r|single colou?r|as (?:shown|pictured|seen)|see (?:image|photo)|n\/?a|none|other|новинка|новинки|распродажа|скидка|хит|нет в наличии|под заказ|новинки|знижка|розпродаж|немає в наявності|хіт)$/i;

/** Letters only, for comparing a candidate with the product's name. */
const key = (s: string) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function namesColour(value: string): boolean {
  return !!canonicalColor(value, "field") || MULTICOLOUR_WORDS.test(value);
}

/**
 * True for a string that is never this product's colour, whatever it looks like.
 *
 * The product's own name is the common one: a colour swatch that is a small
 * photo of the product carries the product's name as its alt text. A candidate
 * made only of the name's words ("Emerson" in "Emerson Skate Shoe") goes too —
 * unless it names a colour, because "Black" is in "Black Hoodie" for a reason.
 */
export function isNotAColour(value: string, context: { name?: string; brand?: string }): boolean {
  const v = key(value);
  if (!v) return true;
  if (NOT_A_COLOUR.test(v)) return true;
  if (/%|[$€£₴₽¥]/.test(value)) return true;
  const name = key(context.name ?? "");
  const brand = key(context.brand ?? "");
  if (v === name || v === brand) return true;
  if (!namesColour(value) && name) {
    const nameWords = new Set(name.split(" "));
    if (v.split(" ").every((w) => nameWords.has(w))) return true;
  }
  return false;
}

/**
 * A variant title's colour part: "Beige/White / XS" is "Beige/White". Only a
 * spaced slash separates options — "Beige/White" itself is one colourway.
 */
function withoutSizes(value: string): string {
  const parts = value.split(/\s+\/\s+/);
  return parts.length > 1 ? parts.filter((p) => !looksLikeSize(p)).join(" / ") : value;
}

/** The colour the candidates agree the page is showing, with where it came from. */
export function chooseColour(
  candidates: (ColourCandidate | undefined)[],
  context: {
    name?: string;
    brand?: string;
    /**
     * The sizes the page offers. A picked size sits in a swatch as a picked
     * colour does, and a store's sizes are not always ones `looksLikeSize`
     * knows ("Size 2", "T1") — so a candidate that is one of them is dropped.
     */
    sizes?: string[];
  },
): ColourCandidate | undefined {
  const sizeKey = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const sizes = new Set((context.sizes ?? []).map(sizeKey));
  const usable = candidates
    .filter((c): c is ColourCandidate => !!c && typeof c.value === "string")
    .map((c) => ({ ...c, value: withoutSizes(c.value.trim().replace(/\s+/g, " ")) }))
    .filter((c) => !sizes.has(sizeKey(c.value)))
    .filter((c) => looksLikeColourLabel(c.value) && !isNotAColour(c.value, context));

  return (
    usable.find((c) => STATING.has(c.origin) && namesColour(c.value)) ??
    usable.find((c) => STATING.has(c.origin)) ??
    usable.find((c) => namesColour(c.value))
  );
}
