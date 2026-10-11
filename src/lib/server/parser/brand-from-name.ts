/**
 * The brand, read off the product's name when the page did not say it — or
 * said the shop instead.
 *
 * A multi-brand store is where this matters. Its structured data leaves the
 * brand out, or fills it with the store's own name, and the brand is sitting in
 * plain sight at the front of the title: "Кросівки Nike Air Max 90",
 * "Acne Studios wool scarf". Every such product used to land with an empty or
 * wrong brand for an admin to fix by hand, one row at a time.
 *
 * Pure: the caller supplies the brands it knows (the admin's Brands list and the
 * brands already in the catalogue) and this only decides. A name is only ever
 * matched against that list, never mined for a capitalised word, so an unknown
 * brand stays unknown rather than becoming "Oversized".
 */
import { escapeRegExp } from "@/lib/text";

/** Values a catalogue row can carry in `brand` that are not a brand. */
const NOT_A_BRAND = new Set([
  "", "unknown", "brand", "other", "others", "none", "n/a", "na", "no brand",
  "nobrand", "generic", "unbranded", "default", "без бренда", "без бренду",
  "інше", "другое",
]);

/** Trademark signs: "Timberland®" is Timberland, "Levi's®" is Levi's. */
const TRADEMARKS = /[®™©℠]/g;

/** Case, accents, trademark signs and spacing folded away, for comparing two spellings of one brand. */
export function foldBrand(value: string): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(TRADEMARKS, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** A brand as it is stored: no trademark sign, single spaces. "Timberland®" is "Timberland". */
export function cleanBrand(value: string): string {
  return (value ?? "").replace(TRADEMARKS, " ").replace(/\s+/g, " ").trim();
}

/**
 * A brand as two stores both spell it: folded, "&" read as "and", and a
 * leading "The" dropped — "The North Face" and "North Face" are one maker.
 */
export function brandWords(value: string): string {
  return foldBrand(value)
    .replace(/&/g, " and ")
    // "Levi's" is "Levis", "Off-White" is "Off White".
    .replace(/['’`´]/g, "")
    .replace(/[\s,.\-‐–/]+/g, " ")
    .replace(/^the /, "")
    .trim();
}

/**
 * One maker under names that share no words. A store selling Jordans files
 * them under "Nike", the brand's own site under "Jordan"; the same hoodie is
 * "Essentials" on one site and "Fear of God" on the next. Spelled here as
 * `brandWords` gives them.
 */
const MAKERS: string[][] = [
  ["nike", "jordan", "air jordan", "nike jordan"],
  ["fear of god", "essentials", "fear of god essentials"],
  ["saint laurent", "yves saint laurent", "ysl"],
  ["ralph lauren", "polo ralph lauren"],
  ["north face", "tnf"],
  ["a bathing ape", "bape"],
  ["comme des garcons", "cdg"],
  ["dr martens", "doc martens"],
];
const MAKER_OF = new Map<string, number>(MAKERS.flatMap((names, i) => names.map((n) => [n, i] as [string, number])));

/** The `MAKERS` entry a brand belongs to, a line after its name included: "Nike SB" is Nike. */
function makerOf(words: string): number | undefined {
  const name = [...MAKER_OF.keys()].find((n) => words === n || words.startsWith(`${n} `));
  return name === undefined ? undefined : MAKER_OF.get(name);
}

/**
 * Do two stores' brand strings name one maker?
 *
 * The same, or one is the other with a line name after it: a reseller writes
 * "adidas Originals" for what adidas.com calls adidas, "Carhartt WIP" for
 * Carhartt, "Nike SB" for Nike. Only a whole-word FRONT counts — "Angels" is
 * not "Palm Angels", and "Off" is not "Off-White" (one word, not two). Or the
 * two are one maker's names (`MAKERS`): Jordan and Nike.
 */
export function brandsAgree(a: string, b: string): boolean {
  const x = brandWords(a);
  const y = brandWords(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.replace(/ /g, "") === y.replace(/ /g, "")) return true;
  const mx = makerOf(x);
  if (mx !== undefined && mx === makerOf(y)) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && long.startsWith(`${short} `);
}

/**
 * Does one row's brand hold for the other? The same maker (`brandsAgree`), or
 * one row has no brand saved and its name spells the other's — cards made
 * before the brand was read carry "Stussy Basic Logo Hoodie" with no brand.
 */
export function brandsFit(a: { brand?: string | null; name: string }, b: { brand?: string | null; name: string }): boolean {
  const x = realBrand(a.brand);
  const y = realBrand(b.brand);
  if (x && y) return brandsAgree(x, y);
  if (x) return positionIn(b.name, x) >= 0;
  if (y) return positionIn(a.name, y) >= 0;
  return false;
}

/** The word a catalogue search for this brand's cards should look for. */
export function brandSearchWord(value: string): string {
  // Its first real word, cut at punctuation, so the read finds every spelling:
  // "levi" is in "Levi's" and "Levis", "martens" in "Dr. Martens".
  const words = foldBrand(value)
    .replace(/^the\s+/, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.find((w) => w.length >= 3) ?? words[0] ?? "";
}

/**
 * A key under which one maker's cards are compared: its `MAKERS` entry when it
 * has one, so Jordan and Nike meet, and its search word otherwise.
 */
export function makerKey(value: string): string {
  const maker = makerOf(brandWords(value));
  return maker !== undefined ? `maker:${maker}` : brandSearchWord(value);
}

/**
 * Every name a brand's maker goes by, to take out of a product's name: "Nike"
 * gives Jordan's names too, so "Nike Air Jordan 1" and "Air Jordan 1" leave
 * the same words behind. A brand outside `MAKERS` is only itself.
 */
export function makerNames(value: string): string[] {
  const maker = makerOf(brandWords(value));
  return maker === undefined ? [value] : [value, ...MAKERS[maker]];
}

/**
 * Words a store's sales copy is made of and a maker's name never is. Whole
 * words only: "Off-White" has no "offer" in it, "New Balance" is not "new".
 */
const SALES_WORDS = new Set([
  "available", "availability", "unavailable", "excluded", "exclude", "excludes", "exclusion", "exclusions",
  "discount", "discounts", "discounted", "promotion", "promotions", "promotional", "promo", "promos",
  "offer", "offers", "coupon", "coupons", "promocode", "shipping", "delivery", "returns", "cart", "checkout",
  "clearance", "markdown", "markdowns", "bestseller", "bestsellers", "wides", "widths", "preorder", "restocked",
  // "Extended Sizes", "Wide Sizing": a line about the sizes a piece comes in.
  "extended", "sizes", "sizing",
  "доставка", "знижка", "знижки", "скидка", "скидки", "акція", "акции", "акция", "промокод", "наявність",
  "наличие", "розпродаж", "распродажа", "кошик", "корзина",
]);

/** A whole text that is a badge on the product, not its maker: "New", "Sale", "Sold out". */
const BADGES = new Set([
  "new", "new in", "new arrival", "new arrivals", "sale", "on sale", "sold out", "best seller", "limited edition",
  "online only", "only online", "exclusive", "online exclusive", "coming soon", "pre order", "back in stock",
  "low stock", "last chance", "just in", "trending", "members only", "новинка", "новинки",
]);

/** More words than this is a sentence: "Comme des Garçons Homme Plus" is five. */
const MAX_BRAND_WORDS = 5;

/**
 * Is this the store's sales copy rather than a maker — the line a store prints
 * under a product's title?
 *
 * Timberland prints "Excluded from all promotional discounts and offers",
 * "Wides Available" or "More Info About Extra 30% Off In Cart!" right under the
 * title, and the extension, which reads the brand-looking element nearest the
 * title, sent those as the brand. They were saved as brands, joined the Brands
 * list as brands, and a card carrying one was a different maker to its own
 * colourways, so it was never grouped with them.
 */
export function isSalesCopy(value: string): boolean {
  const text = foldBrand(value);
  if (!text) return false;
  // A percentage, an exclamation, a price: "30% Off", "In Cart!", "$180".
  if (/[%!?$€£¥₴₽]/.test(text)) return true;
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length > MAX_BRAND_WORDS || text.length > 60) return true;
  if (BADGES.has(words.join(" "))) return true;
  return words.some((w) => SALES_WORDS.has(w));
}

/**
 * True for a value a `brand` field can carry that names no brand: "Unknown",
 * "Other", "Без бренда" — and a store's sales copy (`isSalesCopy`).
 */
export function isNotABrand(value: string): boolean {
  return NOT_A_BRAND.has(foldBrand(value)) || isSalesCopy(value);
}

/**
 * The brand a row really carries: its own, cleaned, or "" when what it carries
 * names no brand. A card saved with sales copy for a brand is, for every
 * comparison, a card saved without one.
 */
export function realBrand(value: string | null | undefined): string {
  const brand = cleanBrand(value ?? "");
  return isNotABrand(brand) ? "" : brand;
}

/** Is this brand spelled, as whole words, inside `text`? */
export function brandSpelledIn(text: string, brand: string): boolean {
  return positionIn(text, brand) >= 0;
}

/** Letters and digits only, for comparing a brand to the labels of a host. */
function compact(value: string): string {
  return foldBrand(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Is this brand spelled, as whole words, inside `text`? Returns where, or -1. */
function positionIn(text: string, brand: string): number {
  const pattern = escapeRegExp(foldBrand(brand)).replace(/ /g, "\\s+");
  // Not `\b`: it only knows ASCII letters, so "Кросівки Nike" and "Stüssy"
  // would get their boundaries wrong. A brand must not continue into a letter
  // or digit on either side — "Cos" is not in "Cosy", "Arket" not in "Market" —
  // nor be one half of a hyphenated word: the "On" of "Pull-On Boot" is not
  // the running brand, and it was filed under it.
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(?<![\\p{L}\\p{N}][-‐–])${pattern}(?![\\p{L}\\p{N}])(?![-‐–][\\p{L}\\p{N}])`,
    "u",
  );
  const m = re.exec(foldBrand(text));
  return m ? m.index : -1;
}

/**
 * The known brands worth matching, de-duplicated by folded spelling. The first
 * spelling seen wins, so pass the admin's curated list before the catalogue's.
 */
export function brandVocabulary(...lists: string[][]): string[] {
  const byFold = new Map<string, string>();
  for (const list of lists) {
    for (const raw of list) {
      const name = cleanBrand(String(raw ?? ""));
      const fold = foldBrand(name);
      // Two characters is a real brand ("A.P.C." compacts to three, "Uniqlo"
      // is long); one is a letter that matches half the catalogue. Sales copy
      // saved as a brand by an earlier run is not one to recognise.
      if (compact(name).length < 2 || isNotABrand(name)) continue;
      if (!byFold.has(fold)) byFold.set(fold, name);
    }
  }
  return [...byFold.values()];
}

/** Who a piece is for, the words a name opens with before its maker: "Women's On Cloud 5". */
const LEADING_WORDS = /^(?:(?:men|women|kids?|boys?|girls?|unisex|toddlers?|baby|youth)(?:['’]s|s['’]|s)?\s+)*/u;

/**
 * Brands this short are everyday words as often as makers — "On", "Gap",
 * "Ash", "Lee" — and count only where a maker's name stands: first.
 */
const SHORT_BRAND = 3;

/**
 * The known brand a product name names, or "" when it names none.
 *
 * The earliest brand in the name wins — a brand leads its product's title far
 * more often than it trails it, and "Nike x Sacai" is Nike's shoe. At the same
 * position the longest wins, so "Acne Studios" beats "Acne". A brand of three
 * letters or fewer counts only at the front, after who the piece is for:
 * "On Cloud 5" and "Women's On Cloud 5" are On's, "Ash Grey Hoodie" and
 * "Bruce Lee Tee" name no maker.
 */
export function brandInName(name: string, brands: string[]): string {
  const front = (LEADING_WORDS.exec(foldBrand(name))?.[0] ?? "").length;
  let best = "";
  let bestAt = Infinity;
  for (const brand of brands) {
    const at = positionIn(name, brand);
    if (at < 0) continue;
    if (compact(brand).length <= SHORT_BRAND && at !== front) continue;
    if (at < bestAt || (at === bestAt && brand.length > best.length)) {
      best = brand;
      bestAt = at;
    }
  }
  return best;
}

/**
 * Models whose maker is not in doubt, for the names that leave the brand out.
 * GOAT and StockX title a Nike "Dunk Low 'Panda'" and an adidas "Samba OG";
 * the brand sits in a field of its own, and when that field is missed the name
 * still says it to anyone who knows the shoe.
 *
 * Matched as whole words in the folded name. Deliberately short: a model that
 * is also an ordinary word ("Blazer", "Boston", "Club") is listed only with the
 * word that makes it the shoe, and a bare number ("550") only in the
 * "550 'White Green'" shape sneaker stores give it, never "Levi's 550".
 */
const MODEL_MAKERS: [RegExp, string][] = (
  [
    ["air jordan|jordan \\d+(?: retro| low| mid| high)?", "Air Jordan"],
    ["(?:sb )?dunk (?:low|high|mid|sb|pro)|air force 1|air max|blazer (?:low|mid)|cortez|vomero|air zoom pegasus|pegasus \\d+|air huarache|air presto|air foamposite|air more uptempo|air vapormax|air rift|shox|p-6000|v2k run|killshot|air trainer|tech fleece", "Nike"],
    // Not "Superstar": Golden Goose's best-known shoe has the same name.
    ["samba|gazelle|campus 00s|stan smith|forum (?:low|mid|high|84)|ultra ?boost|nmd|handball spezial|sl 72|adizero|adilette|ozweego|copa mundial", "adidas"],
    ["(?:550|530|574|327|990v\\d|991|992|993|1500|2002r|1906r|9060|860v2)(?= ['‘’])", "New Balance"],
    ["gel-[a-z0-9]+|gt-2160|gt-2000", "ASICS"],
    ["chuck taylor|chuck 70|run star (?:hike|motion|legacy)|one star", "Converse"],
    ["old skool|sk8-hi|knu skool", "Vans"],
    ["xt-6|xt-4|speedcross|acs pro|xa pro", "Salomon"],
    ["clifton \\d+|bondi \\d+|mafate|speedgoat", "HOKA"],
    ["tasman|tazz", "UGG"],
    ["wallabee", "Clarks"],
    ["club c(?: 85)?", "Reebok"],
    ["speedcat", "Puma"],
    ["mexico 66", "Onitsuka Tiger"],
    ["shadow 6000|grid azura", "Saucony"],
    ["wave rider", "Mizuno"],
    ["jadon", "Dr. Martens"],
    ["nuptse", "The North Face"],
  ] as [string, string][]
).map(([models, brand]) => [new RegExp(`(?<![\\p{L}\\p{N}])(?:${models})(?![\\p{L}\\p{N}])`, "u"), brand]);

/**
 * The maker of a model the name names, in the catalogue's spelling when it has
 * one ("Adidas" if that is how the catalogue writes it), or "".
 */
export function brandFromModel(name: string, known: string[] = []): string {
  const text = foldBrand(name);
  for (const [pattern, brand] of MODEL_MAKERS) {
    if (!pattern.test(text)) continue;
    return known.find((b) => foldBrand(b) === foldBrand(brand)) ?? brand;
  }
  return "";
}

/**
 * Stores that sell many makers' pieces. Their own name is never the brand of a
 * piece, even when an earlier run saved it as one.
 */
const MARKETPLACES = new Set([
  "goat", "stockx", "grailed", "flightclub", "stadiumgoods", "farfetch", "ssense", "mrporter", "netaporter",
  "endclothing", "matchesfashion", "mytheresa", "nordstrom", "selfridges", "zalando", "asos", "yoox",
  "luisaviaroma", "harrods", "lyst", "zappos", "amazon", "ebay", "etsy", "vinted", "depop", "aboutyou",
  "answear", "lamoda", "intertop", "rozetka",
]);

/** Second-level labels a country registry sells under: the shop is the label before them. */
const REGISTRY_LABELS = new Set(["com", "co", "org", "net", "gov", "edu", "ac", "biz", "in", "kiev", "kyiv"]);

/** The label of a host that names the shop: "timberland" in "www.timberland.co.uk". */
export function shopLabel(host: string): string {
  const labels = (host ?? "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length < 2) return compact(labels[0] ?? "");
  let i = labels.length - 2;
  if (i > 0 && REGISTRY_LABELS.has(labels[i])) i--;
  return compact(labels[i]);
}

/** Is this host the brand's own site: timberland.com for Timberland? A marketplace is no maker's. */
export function isOwnShopOf(host: string, brand: string): boolean {
  const label = shopLabel(host);
  return label.length >= 3 && !MARKETPLACES.has(label) && compact(brand) === label;
}

/**
 * The known brand this shop is the own site of, or "": timberland.com is
 * Timberland's, thenorthface.com The North Face's. A marketplace is no maker's.
 */
export function ownShopBrand(host: string, known: string[]): string {
  return known.find((b) => isOwnShopOf(host, b) && !isNotABrand(b)) ?? "";
}

export interface BrandDecision {
  brand: string;
  /** Set when the name decided it, for the import to say so. */
  fromName?: boolean;
  /** Set when it was a model in the name rather than the brand's own word. */
  viaModel?: boolean;
  /** Set when the shop decided it: the page named no maker, on the maker's own site. */
  fromShop?: boolean;
}

/**
 * The brand to store: the page's own word, unless the name says better.
 *
 * `stated` is what the page (or an admin's recipe) gave as the brand; `host` is
 * the store's address. The name says better when it names a known brand, or a
 * model whose maker is not in doubt (`brandFromModel`), and the page said
 * nothing, or said the store's own name ("Intertop" on intertop.ua is the shop,
 * not the maker), or said something we have never seen as a brand.
 *
 * Sales copy is not a brand (`isNotABrand`), and neither is a marketplace's
 * own name: "Wides Available" stated as the brand, or "GOAT" on goat.com, is a
 * page that stated none.
 *
 * `weak` is a brand the page only printed near the product, which the
 * extension read rather than the page declared. The name beats it whenever the
 * two differ, and on a brand's own site the site does too. Up to here a printed
 * brand the catalogue already knew was kept, and on GOAT the one printed first
 * was the menu's "Air Jordan": after one import it was known, and from then on
 * it held for every piece of the run.
 *
 * Nothing named a maker, on a known brand's own site (`ownShopBrand`): the site
 * is the maker. Timberland's "Men's Waterproof Field Boot" names no brand, and
 * on timberland.com it needs none. `ownShop: false` is an admin's rule saying
 * this store is not the brand's own, whatever its address.
 *
 * A stated brand the name confirms is kept, and so is one the page declares in
 * structured data and the catalogue already knows: that is still the store's
 * word over our reading of a name.
 */
export function decideBrand(input: {
  stated: string;
  name: string;
  host: string;
  known: string[];
  weak?: boolean;
  ownShop?: boolean;
}): BrandDecision {
  const said = cleanBrand(input.stated ?? "");
  // Sales copy, and a marketplace's own name, name no maker: "GOAT" on goat.com.
  const marketplace = MARKETPLACES.has(shopLabel(input.host)) && compact(said) === shopLabel(input.host);
  const stated = isNotABrand(said) || marketplace ? "" : said;
  const statedFold = foldBrand(stated);
  // The catalogue's spelling of the stated brand, so "NIKE" files under "Nike"
  // rather than starting a second entry in the brand filter.
  const canonical =
    (statedFold && input.known.find((b) => foldBrand(b) === statedFold)) || stated;
  const statedIsKnown = !!statedFold && input.known.some((b) => foldBrand(b) === statedFold);
  const shop = input.ownShop === false ? "" : ownShopBrand(input.host, input.known);
  const fromShop = (): BrandDecision => ({ brand: shop, fromShop: true });

  const inName = brandInName(input.name, input.known);
  const named = inName || brandFromModel(input.name, input.known);
  const viaModel = !inName && !!named;
  const fromName = (): BrandDecision => ({ brand: named, fromName: true, ...(viaModel ? { viaModel } : {}) });

  if (!named || foldBrand(named) === statedFold) {
    if (!stated) return shop ? fromShop() : { brand: "" };
    // Printed on the maker's own site and confirmed by nothing — not the name,
    // not a model in it: the site's word. Known or not: the line a run before
    // this one put on the Brands list ("Extended Sizes") is "known" too. The
    // maker's other names stand (Jordan on nike.com), as does a maker the name
    // or its model names.
    if (!named && input.weak && shop && !brandsAgree(stated, shop) && positionIn(input.name, stated) < 0) {
      return fromShop();
    }
    return { brand: canonical };
  }

  if (!stated) return fromName();

  // The name repeats the stated brand: it is confirmed, whatever else it names.
  if (positionIn(input.name, stated) >= 0) return { brand: canonical };

  // Printed, not declared: the name is the better witness.
  if (input.weak) return fromName();

  // One maker under another of its names ("Nike" for an Air Jordan), or a
  // model's maker against what the page declares: the page's word.
  if (brandsAgree(stated, named) || viaModel) return { brand: canonical };

  // The store's own name, given as the brand.
  const labels = (input.host ?? "").toLowerCase().split(".").map(compact).filter(Boolean);
  if (labels.includes(compact(stated))) return fromName();

  return statedIsKnown ? { brand: canonical } : fromName();
}
