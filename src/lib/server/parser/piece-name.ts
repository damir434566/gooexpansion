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
  // A store's sales copy in its titles: "NEW", "Sale", "Exclusive".
  "new", "sale", "exclusive", "authentic", "новинка", "новинки", "розпродаж", "распродажа",
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
  /** The name with brand, colour, filler and article codes removed. */
  full: string;
  /** `full` without garment-type words. Only trusted when `strongCore` says so. */
  core: string;
  /** Article codes the name carried ("cw2288111"), letters and digits only. */
  codes: string[];
}

/**
 * An article code inside a name: letters then three or more digits, with the
 * colour part a maker hangs off it — Nike's "CW2288-111", adidas's "GW2871",
 * New Balance's "U9060EEB" — or a bare number of six digits and more. A store
 * that prints the code in its title ("Кросівки Nike Air Force 1 '07
 * CW2288-111") named a piece the brand's own site calls "Air Force 1 '07",
 * and the extra "cw2288 111" kept the two apart. A model named by digits first
 * ("2002R", "990v6") is not a code.
 */
const ARTICLE_CODE =
  /(?<![\p{L}\p{N}])(?:[a-z]{1,4}\d{3,}[a-z0-9]*(?:[-‐–/][a-z0-9]{2,4}|\s\d{3}(?![\p{L}\p{N}]))?|\d{6,}(?:[-/]\d{1,4})?)(?![\p{L}\p{N}])/gu;

/** A season, not an article: "SS26", "FW2026". */
const SEASON_CODE = /^(?:ss|fw|aw|sp|fa|su|ho|pf|re)\d{2,4}$/;

/**
 * What an `ARTICLE_CODE` match is: an article code, a season (dropped, never
 * compared), or a model's name — the short ones are models as often as codes,
 * "ZX750", "P6000", and stay in the name.
 */
function codeKind(match: string): "code" | "season" | "name" {
  const compact = match.replace(/[^\p{L}\p{N}]+/gu, "");
  if (SEASON_CODE.test(compact)) return "season";
  const digits = compact.replace(/\D/g, "").length;
  return compact !== match || digits >= 4 || compact.length >= 7 ? "code" : "name";
}

/**
 * The article codes in a text as database patterns: "CW2288-111" is
 * `cw2288%111`, so a card that stored "CW2288 111" is found by it.
 */
export function articleCodePatterns(text: string): string[] {
  const out = new Set<string>();
  for (const m of foldBrand(text ?? "").matchAll(ARTICLE_CODE)) {
    if (codeKind(m[0]) === "code") out.add(m[0].replace(/[^\p{L}\p{N}]+/gu, "%"));
  }
  return [...out];
}

/** A colour label's parts as a name repeats them: "Cloud White / Core Black / Gum" → three. */
function colourPhrases(colors: string[]): string[] {
  const out = new Set<string>();
  for (const label of colors) {
    const folded = foldBrand(label ?? "");
    if (folded.length >= 3) out.add(folded);
    for (const part of folded.split(/\s*[/,&+|()[\]]+\s*|\s+(?:and|і|и)\s+/u)) {
      const p = part.trim();
      if (p.length >= 3) out.add(p);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * The piece a name describes.
 *
 * `colors` are the row's stated colours: "Core Black" is removed as a phrase,
 * so the "Core" goes with it rather than staying behind as part of the name.
 */
/**
 * How a brand's own line appears in a product's name, beyond the brand itself.
 * Jordan's shoes are "Air Jordan 4" on one store and "Jordan 4" on the next.
 */
const BRAND_LINES: Record<string, string[]> = {
  jordan: ["air jordan"],
};

export function pieceName(name: string, brand: string | string[], colors: string[] = []): PieceName {
  let text = foldBrand(cleanName(name ?? ""));

  // Every spelling of the maker comes out, longest first, so "Carhartt WIP"
  // leaves nothing behind where "Carhartt" alone would leave "wip".
  const brands = (Array.isArray(brand) ? brand : [brand]).map((v) => foldBrand(v ?? "")).filter(Boolean);
  const spellings = [...new Set(brands.flatMap((b) => [...(BRAND_LINES[b] ?? []), b]))].sort(
    (p, q) => q.length - p.length,
  );
  for (const b of spellings) text = text.replace(phrase(b), " ");
  for (const c of colourPhrases(colors)) text = text.replace(phrase(c), " ");

  const codes: string[] = [];
  text = text.replace(ARTICLE_CODE, (code) => {
    const kind = codeKind(code);
    if (kind === "code") codes.push(code.replace(/[^\p{L}\p{N}]+/gu, ""));
    return kind === "name" ? code : " ";
  });

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
    codes,
  };
}

/**
 * The article codes a row carries: in its name, and the maker's part number.
 * Never the store's SKU — two retailers use one SKU string for two things.
 */
export function articleCodes(row: { name: string; mpn?: string | null }): string[] {
  const out = new Set(pieceName(row.name, "").codes);
  const mpn = (row.mpn ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (mpn.length >= 5) out.add(mpn);
  return [...out];
}

/**
 * Do two rows carry the same article code? Letters and digits both, five
 * characters or more — a number alone is too often a store's own shelf number.
 * The same code is the same piece; its colour is still asked of the colours.
 */
export function shareArticleCode(a: string[], b: string[]): boolean {
  const theirs = new Set(b);
  return a.some((c) => theirs.has(c) && c.length >= 5 && /\p{L}/u.test(c) && /\d/.test(c));
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

/**
 * Two rows' categories, as evidence that they are different pieces. Two stores
 * file one sweatshirt under "knitwear" and "tops", so a category alone is not
 * enough to tell pieces apart: it counts only when the names also name two
 * different garments — a Windrunner jacket and Windrunner trousers.
 */
function differentGarments(a: PieceRow, b: PieceRow): boolean {
  return !categoriesAgree(a.category, b.category) && garmentTypesConflict(a.name, b.name);
}

/** Enough of a model's own words, without its brand, to name one maker's piece. */
function distinctive(p: PieceName): boolean {
  const words = p.full
    .split(" ")
    .filter((t) => t && !TYPE_WORDS.has(t) && !NOT_A_MODEL.has(t) && !/^(?:19|20)\d\d$/.test(t));
  return words.length >= 2;
}

/** A model number of three digits or more in a reduced name — not a year. */
function numberedModel(full: string): boolean {
  return full.split(" ").some((t) => /\d{3}/.test(t) && !/^(?:19|20)\d\d$/.test(t));
}

export interface PieceRow {
  name: string;
  colors?: string[] | null;
  category?: string | null;
}

/** Are these two rows, of one brand, the same piece (in any colour)? */
/**
 * The word that best picks this model out of its brand's cards: the longest
 * word of the reduced name that has letters in it — "windrunner", "nuptse" —
 * never the brand, a colour or the garment word. Ties go alphabetically, so
 * two spellings of one model pick the same word. Empty when there is none.
 */
export function modelWord(name: string, brand: string | string[], colors: string[] = []): string {
  const piece = pieceName(name, brand, colors);
  const words = (piece.core || piece.full).split(" ").filter((w) => /\p{L}/u.test(w) && w.length >= 4);
  return words.sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? "";
}

/**
 * Words a second store adds to a model's name without making it another model:
 * the year of a release, the garment word, filler, a colour.
 */
function addsNothing(token: string): boolean {
  return /^(?:19|20)\d\d$/.test(token) || TYPE_WORDS.has(token) || FILLER.has(token) || colorWordsIn(token).length > 0;
}

/**
 * One store's name is the other's with only words that add nothing: "Jordan 4
 * Retro Toro Bravo" and StockX's "Air Jordan 4 Retro 'Toro Bravo' (2026)".
 * The shorter must still name a model — three words, or two with a number —
 * so "Jordan 4 Retro" never takes in "Jordan 4 Retro Toro Bravo": the extra
 * "toro bravo" is a colourway, which adds everything.
 */
function sameModelLonger(x: PieceName, y: PieceName): boolean {
  const a = x.full.split(" ").filter(Boolean);
  const b = y.full.split(" ").filter(Boolean);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const shortSet = new Set(short);
  if (shortSet.size < 2 || short.join(" ").length < MIN_PIECE_NAME) return false;
  if (shortSet.size < 3 && !short.some((t) => /\d/.test(t))) return false;
  const longSet = new Set(long);
  if (![...shortSet].every((t) => longSet.has(t))) return false;
  return [...longSet].every((t) => shortSet.has(t) || addsNothing(t));
}

/**
 * Are two rows one piece? `brand` is every spelling of the maker the two rows
 * use — "Carhartt WIP" and "Carhartt" — so each name loses all of them.
 */
export function samePiece(
  brand: string | string[],
  a: PieceRow,
  b: PieceRow,
  opts: { strict?: boolean } = {},
): boolean {
  const brands = Array.isArray(brand) ? brand : [brand];
  if (!brands.some((v) => foldBrand(v ?? ""))) return false;
  if (differentGarments(a, b)) return false;
  // Both rows' colours come out of both names: one store's title carries its
  // colourway ("Samba OG 'Cloud White Core Black'", "Detroit Jacket Black
  // Rinsed") and the other's colour label is the only place that says so.
  const colours = [...(a.colors ?? []), ...(b.colors ?? [])];
  const x = pieceName(a.name, brands, colours);
  const y = pieceName(b.name, brands, colours);
  if (shareArticleCode(x.codes, y.codes)) return true;
  // Strict is for a row that names no brand at all: only a name that is a
  // model on its own stands in for the brand — two words that are neither a
  // garment nor what every brand calls its pieces. "Air Max 90" and "Bullet
  // Hole Jeans" are; "Classic Logo Tee" and "Detroit Jacket" could be anyone's.
  if (opts.strict && !(distinctive(x) && distinctive(y))) return false;
  if (x.full.length >= MIN_PIECE_NAME && x.full === y.full) return true;
  // A maker that names its models by number — New Balance's "9060", "550" —
  // leaves a name too short for the test above, and the number is the model.
  if (!opts.strict && x.full && x.full === y.full && numberedModel(x.full)) return true;
  if (strongCore(x.core) && x.core === y.core) return true;
  if (sameModelLonger(x, y)) return true;
  if (opts.strict) return false;
  return singleWordModel(x, y, a, b);
}

/**
 * Could these two rows be one model's colourways, as a store's colour row
 * links them? Looser than `samePiece`, because the store has already said so —
 * etnies links "Emerson X FOS" beside "Emerson" — and strict enough to refuse a
 * link that cannot be one: the colour row a page was read from was sometimes a
 * "you may also like" grid, and "Cypher Woven Jacket", "Ritual Jacket" and
 * "Stack Jacket" became one jacket in five colours.
 *
 * The same piece; or, with no category or garment against it, a reduced name
 * that starts with the same model word, or that is the start of the other.
 */
export function sameModelFamily(brand: string, a: PieceRow, b: PieceRow): boolean {
  if (samePiece(brand, a, b)) return true;
  if (!categoriesAgree(a.category, b.category)) return false;
  if (garmentTypesConflict(a.name, b.name)) return false;
  const words = (row: PieceRow) => {
    const p = pieceName(row.name, brand, row.colors ?? []);
    return (p.core || p.full).split(" ").filter(Boolean);
  };
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.every((w, i) => long[i] === w) && short.join(" ").length >= 4) return true;
  // A shared first word is a model only when it is long enough to be a name
  // and is not a brand's line: Nike's "Air" starts the Force 1 and the Max 90.
  const root = x[0];
  return root === y[0] && root.length >= 4 && !/\d/.test(root) && !NOT_A_MODEL.has(root) && !LINE_WORDS.has(root);
}

/** First words a brand starts many different models with. */
const LINE_WORDS = new Set([
  "air", "zoom", "ultra", "super", "free", "react", "speed", "force", "court", "retro", "cloud",
  "gel", "fresh", "foam", "boost", "old", "skool", "chuck", "club", "dunk", "blazer", "jordan",
  "yeezy", "tech", "nano", "wave", "trail", "hyper", "flex", "metcon", "pegasus",
]);

/**
 * How the colours of two rows of one piece compare.
 *
 *   same       the same colour word ("Black" / "black")
 *   near       different words, the same colours ("Core Black" / "Black",
 *              "grey/white/leather" / "White/Grey")
 *   partial    one side names some of the other's colours and nothing else
 *              ("Grey" / "grey/white/leather") — a store naming only the main
 *              colour, or another colourway; which of the two, only the other
 *              rows of the piece can tell
 *   different  different colours
 *   unknown    one side states no colour
 *   none       neither side states one
 */
export type ColourRelation = "same" | "near" | "partial" | "different" | "unknown" | "none";

/**
 * A colour label for comparison: lower case, Latin accents off ("Crème" is
 * "creme"), Cyrillic whole. `foldBrand` strips every mark, and "й" is "и" with
 * one — so "Сірий" became "сірии", which no colour dictionary knows, and a
 * Ukrainian store's grey never met etnies' "grey/white/leather".
 */
function foldColour(value: string): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/([a-z])\p{M}+/giu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function colourRelation(a?: string[] | null, b?: string[] | null): ColourRelation {
  // Every colour a row lists, not its first: a card saved as ["White", "Black"]
  // and a page saying ["Black", "White"] are one colourway, and comparing the
  // first entries called them two.
  const x = foldColour((a ?? []).filter(Boolean).join(" / "));
  const y = foldColour((b ?? []).filter(Boolean).join(" / "));
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
    const [small, large] = sx.size <= sy.size ? [sx, sy] : [sy, sx];
    if (![...small].every((c) => large.has(c))) return "different";
    return small.size === large.size ? "near" : "partial";
  }
  const cx = canonicalColor(x, "field");
  const cy = canonicalColor(y, "field");
  return cx && cy && cx === cy ? "near" : "different";
}
