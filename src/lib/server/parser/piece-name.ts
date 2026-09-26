/**
 * Which piece a product name describes, with everything that is not the piece
 * taken off: the brand, the colour, who it is for, and the store's habit of
 * putting the garment type in front of the model in the local language.
 *
 * Two questions are asked of it, and both need the same answer first:
 *
 *   Is this the same piece in another colour?   → group it (a swatch row)
 *   Is this the same piece, same colour, sold by another store?
 *                                               → one product, two places to buy
 *
 * What used to decide the first was a base name that dropped a single ASCII
 * word after " - ". So "Nebula Jacket - Black" grouped, and none of these did:
 * "Nebula Jacket Core Black", "Wool coat in camel", "Кросівки Nike Air Max 90
 * чорні" beside "Nike Air Max 90 White". The second question had no name
 * answer at all, and most stores print no barcode to answer it by.
 *
 * The test stays conservative, because a wrong "same" is worse than a missed
 * one: two different coats shown as one, or a link that sends a shopper to
 * something else. So the name has to match exactly once reduced, a reduced
 * name shorter than a real model name matches nothing, and a category the two
 * rows disagree on vetoes the match.
 */
import { cleanName, colorWordsIn, canonicalColor } from "@/lib/server/product-fields";
import { garmentTypesConflict } from "@/lib/taxonomy/garments";
import { foldBrand } from "./brand-from-name";

/**
 * Shortest reduced name worth matching on. Below this a name is a word, not an
 * identity: "tee" or "bag" would fold a brand's catalogue into one card.
 */
export const MIN_PIECE_NAME = 8;

/**
 * Words that say who a piece is for, tie a colour on, or name the brand's line
 * rather than the piece — never which piece. "Originals" is adidas's line:
 * a reseller's "adidas Originals Samba OG Shoes" is adidas.com's "Samba OG".
 */
const FILLER = new Set([
  "in", "colour", "color", "col", "men", "mens", "man", "women", "womens", "woman", "unisex",
  "originals",
  "колір", "кольору", "цвет", "цвета", "унісекс", "унисекс",
  "чоловічі", "чоловічий", "чоловіча", "чоловіче", "жіночі", "жіночий", "жіноча", "жіноче",
  "мужские", "мужской", "мужская", "мужское", "женские", "женский", "женская", "женское",
]);

/**
 * What a piece is, as opposed to which piece it is. Dropped only for the second
 * comparison below, and only when what remains still names a model on its own
 * ("Air Max 90 Sneakers" is "Air Max 90"); "Wool Coat" is not reduced to "wool".
 */
const TYPE_WORDS = new Set([
  "jacket", "jackets", "coat", "parka", "blazer", "shirt", "tee", "top", "hoodie",
  "sweatshirt", "sweater", "jumper", "cardigan", "pullover", "trousers", "pants",
  "jeans", "shorts", "skirt", "dress", "sneakers", "sneaker", "trainers", "trainer",
  "shoes", "shoe", "boots", "boot", "sandals", "loafers", "bag", "backpack", "cap",
  "hat", "beanie", "scarf", "vest", "gilet", "polo", "longsleeve",
]);

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /[a-z]/;

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A folded phrase as a whole-word pattern, spacing loose. */
function phrase(folded: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRe(folded).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`,
    "gu",
  );
}

export interface PieceName {
  /** The name with brand, colour and filler removed. */
  full: string;
  /** `full` without garment-type words. Only trusted when `strongCore` says so. */
  core: string;
}

/**
 * The piece a name describes.
 *
 * `colors` are the row's stated colours: "Core Black" is removed as a phrase,
 * so the "Core" goes with it rather than staying behind as part of the name.
 */
export function pieceName(name: string, brand: string, colors: string[] = []): PieceName {
  let text = foldBrand(cleanName(name ?? ""));

  const b = foldBrand(brand ?? "");
  if (b) text = text.replace(phrase(b), " ");
  for (const color of colors) {
    const c = foldBrand(color ?? "");
    if (c.length >= 3) text = text.replace(phrase(c), " ");
  }

  let tokens = text
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    // "men's" leaves an "s"; a lone letter names nothing. A lone digit does
    // ("Air Force 1").
    .filter((t) => t.length > 1 || /\d/.test(t))
    .filter((t) => !FILLER.has(t))
    .filter((t) => !colorWordsIn(t).length);

  // A Ukrainian or Russian store writes "Кросівки Nike Air Max 90 чорні": the
  // model is the Latin part, and the Cyrillic words around it are the store
  // describing it in its own language. Another store names the same shoe
  // "Nike Air Max 90". So when both scripts are present, the Latin part is the
  // name. A name written wholly in Cyrillic is kept whole.
  if (tokens.some((t) => LATIN.test(t)) && tokens.some((t) => CYRILLIC.test(t))) {
    tokens = tokens.filter((t) => !CYRILLIC.test(t));
  }

  return {
    full: tokens.join(" "),
    core: tokens.filter((t) => !TYPE_WORDS.has(t)).join(" "),
  };
}

/**
 * Does a reduced name identify a model without its garment word?
 * "air max 90" does — a number is a model. "windrunner" alone does not: Nike
 * sells a Windrunner jacket and Windrunner trousers.
 */
function strongCore(core: string): boolean {
  if (core.length < MIN_PIECE_NAME) return false;
  return /\d/.test(core) || core.split(" ").length >= 2;
}

/**
 * Words a brand puts on many pieces at once. Left alone after the brand and the
 * garment word are gone, they name a line or a finish, not a model: every
 * brand has a "Classic" tee and a "Classic" hoodie.
 */
const NOT_A_MODEL = new Set([
  "classic", "classics", "basic", "basics", "essential", "essentials", "original", "originals",
  "signature", "standard", "regular", "core", "new", "premium", "heritage", "vintage", "retro",
  "pro", "sport", "sports", "club", "team", "icon", "logo", "plain", "simple", "everyday",
  "relaxed", "oversized", "slim", "fit", "cropped", "long", "short", "low", "high", "mid", "lite",
  "light", "heavy", "heavyweight", "lightweight", "organic", "cotton", "wool", "leather", "suede",
  "canvas", "denim", "nylon", "fleece", "knit", "jersey", "tech", "utility", "cargo", "graphic",
  "print", "printed", "striped", "stripe", "check", "pocket", "zip", "hooded", "crew", "crewneck",
  "script", "box", "mini", "maxi", "midi", "trefoil", "monogram", "sleeve", "sleeveless",
  "adicolor", "collection", "edition", "limited", "special", "exclusive", "collab",
]);

/**
 * A model named in one word — "Emerson", "Samba", "Gazelle" — once the brand
 * and the garment word are gone.
 *
 * One word used to be too little to match on: `strongCore` wants a number or
 * two words, because Nike sells a Windrunner jacket and Windrunner trousers.
 * But etnies names its shoe "Emerson" on its own site and a reseller calls it
 * "Etnies Shoes Emerson", and neither ever says more. So a single word counts
 * when everything else vouches for it: both rows are filed under the same real
 * category, the word is not one a brand puts on everything, and the names do
 * not describe two different garments.
 */
function singleWordModel(x: PieceName, y: PieceName, a: PieceRow, b: PieceRow): boolean {
  if (!x.core || x.core !== y.core) return false;
  if (x.core.includes(" ") || x.core.length < 4 || /\d/.test(x.core)) return false;
  if (NOT_A_MODEL.has(x.core)) return false;
  if (!a.category || !b.category || a.category !== b.category || a.category === "accessories") return false;
  return !garmentTypesConflict(a.name, b.name);
}

/** Categories that disagree veto a match; the importer's fallback bucket says nothing. */
function categoriesAgree(a?: string | null, b?: string | null): boolean {
  if (!a || !b || a === "accessories" || b === "accessories") return true;
  return a === b;
}

export interface PieceRow {
  name: string;
  colors?: string[] | null;
  category?: string | null;
}

/** Are these two rows, of one brand, the same piece (in any colour)? */
export function samePiece(brand: string, a: PieceRow, b: PieceRow): boolean {
  if (!foldBrand(brand)) return false;
  if (!categoriesAgree(a.category, b.category)) return false;
  const x = pieceName(a.name, brand, a.colors ?? []);
  const y = pieceName(b.name, brand, b.colors ?? []);
  if (x.full.length >= MIN_PIECE_NAME && x.full === y.full) return true;
  if (strongCore(x.core) && x.core === y.core) return true;
  return singleWordModel(x, y, a, b);
}

/**
 * How the colours of two rows of one piece compare.
 *
 *   same       the same colour word ("Black" / "black")
 *   near       different words, the same colours ("Core Black" / "Black",
 *              "grey/white/leather" / "White/Grey")
 *   different  different colours
 *   unknown    one side states no colour
 *   none       neither side states one
 */
export type ColourRelation = "same" | "near" | "different" | "unknown" | "none";

export function colourRelation(a?: string[] | null, b?: string[] | null): ColourRelation {
  const x = foldBrand(a?.[0] ?? "");
  const y = foldBrand(b?.[0] ?? "");
  if (!x && !y) return "none";
  if (!x || !y) return "unknown";
  if (x === y) return "same";
  // A two-tone piece is its set of colours, whatever order a store lists them
  // in: one store's "grey/white/leather" is another's "White/Grey". Comparing
  // the last colour word of each called those different. Only words that are
  // colours anywhere are counted, so the "Natural" in "Natural Black" does not
  // make it a second colour.
  const sx = new Set(colorWordsIn(x, "text"));
  const sy = new Set(colorWordsIn(y, "text"));
  if (sx.size && sy.size) {
    return sx.size === sy.size && [...sx].every((c) => sy.has(c)) ? "near" : "different";
  }
  const cx = canonicalColor(x, "field");
  const cy = canonicalColor(y, "field");
  return cx && cy && cx === cy ? "near" : "different";
}
