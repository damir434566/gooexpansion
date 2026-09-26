/**
 * The colour dictionary: the names shops give colours, and the base colour each
 * one belongs to.
 *
 * Three tiers, because colour words are read from very different places.
 *
 *   SAFE words mean a colour wherever they appear. They are read from the
 *   store's colour field, but also from the product's *name* and URL slug when
 *   the page states no colour, and they are stripped from names when the same
 *   piece is matched across stores. So a safe word must not also be a brand, a
 *   garment, a fabric or an ordinary adjective.
 *
 *   FIELD words are colours only where the text is known to be a colour — the
 *   store's colour field, a swatch label. "Stone" is a colour in the colour
 *   field and a brand in "Stone Island Jacket"; "Linen" is a colour on a swatch
 *   and a fabric in "Linen Shirt"; "Cloud" is a colour on a swatch and a shoe in
 *   "On Cloud 5". Reading those from a name filed Stone Island under Beige and
 *   every linen shirt under Beige.
 *
 *   QUALIFIER words ("Marl", "Melange", "Heather") describe a yarn more than a
 *   colour. Alone in a colour field they are grey; next to a colour ("Navy
 *   Marl") the colour is the answer.
 *
 * Within one label a safe word beats a field word beats a qualifier, so "Black
 * Linen" is black and "Stone" alone is beige. Among words of one tier the last
 * wins, because a colourway puts its qualifier first ("Cloud White").
 *
 * Every entry is a single word: labels are split into words before lookup, so
 * a hyphenated or spaced entry could never match. Two-word colourways live in
 * COLOUR_PHRASES.
 *
 * Several words that used to sit in the single list are in the field tier now
 * for exactly those reasons: stone, linen, chrome, steel, ash, marine, snow,
 * chalk, natural, jet, coal, smoke, sky, forest, moss, mint, rose, cherry,
 * butter, peach, denim, golden (Golden Goose), caviar (Chanel's leather). In a
 * colour field they read as before.
 */

export type Base =
  | "black" | "white" | "grey" | "beige" | "brown" | "blue"
  | "green" | "red" | "pink" | "yellow" | "orange" | "violet";

const tier = (entries: Partial<Record<Base, string[]>>): Record<string, Base> => {
  const out: Record<string, Base> = {};
  for (const [base, words] of Object.entries(entries) as [Base, string[]][]) {
    for (const w of words) out[w] = base;
  }
  return out;
};

/** Mean a colour anywhere: field, name, slug. */
export const SAFE_COLOUR_WORDS: Record<string, Base> = tier({
  black: [
    "black", "noir", "nero", "negro", "schwarz", "zwart", "svart", "czarny",
    "onyx", "ebony", "obsidian", "licorice", "liquorice", "anthracite", "anthra", "carbon",
    "jetblack", "blackout",
  ],
  white: [
    "white", "blanc", "bianco", "blanco", "weiss", "weiß", "vit", "biały", "bialy",
    "ivory", "alabaster", "eggshell", "offwhite", "opticwhite",
  ],
  grey: [
    "grey", "gray", "gris", "grigio", "grau", "grijs", "grå",
    "charcoal", "graphite", "slate", "silver", "pewter", "gunmetal", "platinum", "titanium",
    "dove", "greyish", "grayish", "nickel",
  ],
  beige: [
    "beige", "cream", "ecru", "écru", "ecrue", "creme", "crème", "oat", "oatmeal", "nude", "taupe",
    "khaki", "camel", "champagne", "bone", "greige", "fawn", "parchment", "vanilla", "biscuit",
    "sandstone", "latte", "cappuccino", "putty", "almond", "wheat", "cashew", "mushroom",
  ],
  brown: [
    "brown", "braun", "bruin", "marron", "marrone", "marrón",
    "chocolate", "chocolat", "coffee", "mocha", "espresso", "cognac", "chestnut", "walnut", "hazel",
    "hazelnut", "bronze", "toffee", "caramel", "tan", "rust", "cocoa", "tobacco", "umber", "sienna",
    "mahogany", "cinnamon", "pecan", "rawhide", "tortoise", "tortoiseshell", "havana", "brunette",
    "russet", "auburn", "sepia", "tawny", "nutmeg", "molasses", "peat",
  ],
  blue: [
    "blue", "bleu", "blu", "azul", "blau", "blauw", "niebieski",
    "navy", "indigo", "cobalt", "azure", "teal", "aqua", "turquoise", "petrol", "cyan",
    "sapphire", "cornflower", "ultramarine", "periwinkle", "cerulean", "prussian", "marino",
    "bluebird", "steelblue", "lapis", "celeste", "aquamarine", "blueish", "bluish", "saxe",
  ],
  green: [
    "green", "vert", "verde", "grün", "grun", "groen", "zielony",
    "olive", "sage", "emerald", "pistachio", "lime", "chartreuse", "celadon", "seafoam",
    "viridian", "malachite", "avocado", "spruce", "juniper", "eucalyptus", "matcha", "greenish",
    "olivine", "lichen", "fern", "jade",
  ],
  red: [
    "red", "rouge", "rosso", "rojo", "rot", "rood", "czerwony",
    "crimson", "scarlet", "burgundy", "wine", "bordeaux", "maroon", "ruby", "oxblood", "claret",
    "merlot", "garnet", "vermilion", "vermillion", "carmine", "cranberry", "raspberry",
    "redcurrant", "currant", "reddish", "sangria", "cerise",
  ],
  pink: [
    "pink", "rosa", "roze", "różowy", "blush", "fuchsia", "fuschia", "magenta", "salmon", "coral",
    "bubblegum", "flamingo", "rosewood", "carnation", "pinkish", "petal", "watermelon", "rosé",
  ],
  yellow: [
    "yellow", "jaune", "giallo", "amarillo", "gelb", "geel", "żółty",
    "mustard", "lemon", "gold", "ochre", "ocher", "amber", "canary", "saffron",
    "sunflower", "maize", "citron", "dandelion", "banana", "marigold", "yellowish", "goldenrod",
  ],
  orange: [
    "orange", "arancione", "naranja", "oranje", "pomarańczowy",
    "apricot", "tangerine", "papaya", "terracotta", "copper", "pumpkin",
    "cantaloupe", "persimmon", "clementine", "ginger", "tangelo", "orangey", "cinnabar",
  ],
  violet: [
    "violet", "purple", "lilac", "lavender", "plum", "mauve", "aubergine", "eggplant", "amethyst",
    "orchid", "grape", "wisteria", "heliotrope", "mulberry", "damson", "thistle", "lila",
    "purpura", "fioletowy", "purplish", "byzantium", "boysenberry",
  ],
});

/**
 * Colours only where the text is known to be a colour: the colour field, a swatch.
 *
 * Only settled colour names. A store's own poetry ("Storm", "Sunset", "Fire",
 * "Moon") is left out on purpose: a label with no colour word goes on to the
 * product photo (see `import-product.ts`), and a measured photo is better
 * evidence than a guess at what "Babymetal Storm" was meant to look like.
 */
export const FIELD_COLOUR_WORDS: Record<string, Base> = tier({
  black: ["jet", "coal", "ink", "raven", "soot", "caviar"],
  white: [
    "snow", "chalk", "optic", "cloud", "porcelain", "pearl", "milk", "paper", "salt", "frost",
    "coconut", "lily", "sail",
  ],
  grey: [
    "ash", "steel", "smoke", "chrome", "fog", "cement", "concrete", "iron", "pebble", "flint",
    "mist", "zinc", "cinder", "granite",
  ],
  beige: [
    "stone", "sand", "linen", "natural", "dune", "twine", "jute", "oyster", "flax", "straw",
    "sable", "buff", "desert", "honeycomb",
  ],
  brown: [
    "bark", "wood", "timber", "cedar", "oak", "acorn", "mud", "whisky", "whiskey", "bourbon",
    "saddle",
  ],
  blue: [
    "denim", "sky", "marine", "ocean", "lake", "admiral", "harbour", "harbor", "sea", "ice",
    "glacier", "midnight", "arctic", "royal", "cadet",
  ],
  green: [
    "forest", "moss", "mint", "army", "pine", "ivy", "leaf", "hunter", "bottle", "military",
    "cactus", "basil", "herb", "palm", "jungle", "clover", "grass", "bamboo", "loden", "kelly",
  ],
  red: ["cherry", "brick", "tomato", "cardinal", "strawberry", "berry", "poppy", "chili", "paprika", "blood"],
  pink: ["rose", "peony", "ballet", "shrimp"],
  yellow: ["butter", "honey", "corn", "custard", "mimosa", "sulphur", "sulfur", "golden"],
  orange: ["peach", "clay", "melon", "carrot", "mango"],
  violet: ["fig", "beetroot", "iris", "viola", "ube"],
});

/** A yarn more than a colour: grey alone, silent beside a real colour. Field only. */
export const QUALIFIER_COLOUR_WORDS: Record<string, Base> = tier({
  grey: ["heather", "heathered", "marl", "marled", "melange", "mélange", "chine", "chiné"],
});

/**
 * Russian and Ukrainian colour adjectives, matched against whole words because
 * they decline ("графитовый", "графитовая", "графитовое"). The short stems are
 * pinned to adjective endings: a bare "сер" read "серьги" as grey, a bare
 * "син" read "синтепон" as blue, a bare "бел" read "бельё" as white.
 */
export const COLOUR_STEMS: [RegExp, Base][] = [
  [/^(?:ч[её]рн|чорн|угольн|вугільн|антрацит|смолян)/, "black"],
  [/^(?:бел[ыаоуе]|біл(?:ий|а|е|і|ого|ому|им|ими|их|ій|ої|у|ую|осніж)|молочн|сливочн|айвори|жемчужн|перлов)/, "white"],
  [/^(?:сер[ыаоу]|серебр|сір(?:ий|а|е|і|ого|ому|им|их|ій|ої|у)|сріб|графит|графіт|дымчат|димчаст|пепельн|попелят|свинцов|мышин|асфальт)/, "grey"],
  [/^(?:беж|кремов|песочн|пісочн|экрю|екрю|кэмел|кемел|телесн|тілесн|нюд|овсян)/, "beige"],
  [/^(?:коричн|шокол|коньячн|карамел|табачн|кофейн|кавов|мокко|орехов|горіхов|бронзов|каштанов|рыж)/, "brown"],
  [/^(?:син[иеяюь]|голуб|блакит|индиго|індиго|бирюз|бірюз|васильков|волошков|лазурн|небесн|сапфиров|ультрамарин|электрик|електрик|аквамарин)/, "blue"],
  [/^(?:з[еи]л[её]н|оливков|хаки|хакі|мятн|изумруд|смарагд|фисташк|фісташк|салатов|хвойн|бутылочн|болотн|травян|малахит)/, "green"],
  [/^(?:красн|червон|бордов|винн|вишн|малинов|кирпичн|цеглян|рубинов|ал(?:ый|ая|ое|ые|ого|ой)$|гранатов|марсал|бургунд)/, "red"],
  [/^(?:розов|рожев|пудр|фукси|фуксі|корал|лососев)/, "pink"],
  [/^(?:ж[её]лт|жовт|горчичн|гірчичн|лимонн|золот|янтарн|бурштин|охр[аоыи]|шафран|канареечн|медов)/, "yellow"],
  [/^(?:оранж|помаранч|терракот|теракот|персик|абрикос|морковн|медн|мідн|апельсин|мандарин)/, "orange"],
  [/^(?:фиолет|фіолет|сирен|бузков|лаванд|лилов|сливов|аметист|баклажан|пурпур|виноград|ежевичн)/, "violet"],
];

/** Stems that are colours only in a colour field: "джинсовая куртка" is a denim jacket, not a blue one. */
export const FIELD_COLOUR_STEMS: [RegExp, Base][] = [
  [/^(?:снежн|сніжн)/, "white"],
  [/^(?:стальн|сталев)/, "grey"],
  [/^(?:льнян|ллян)/, "beige"],
  [/^(?:джинсов|морск|морськ)/, "blue"],
];

/** Russian "меланж": a qualifier like "marl". */
export const QUALIFIER_COLOUR_STEMS: [RegExp, Base][] = [[/^меланж/, "grey"]];

/**
 * Colourways whose meaning is destroyed by reading their words separately, or
 * whose words sit in the field tier but mean something certain together.
 * Phrases count as safe: "Sky Blue" is blue in a name as much as in a field.
 */
export const COLOUR_PHRASES: [RegExp, Base][] = [
  [/\broses?[\s-]?gold\b/, "pink"],
  [/\bgold(?:en)?[\s-]?ros[eé]\b/, "pink"],
  [/\boff[\s-]?white\b/, "white"],
  [/\braw[\s-]?white\b/, "white"],
  [/\boptic(?:al)?[\s-]?white\b/, "white"],
  [/\bnavy[\s-]?blue\b/, "blue"],
  [/\boff[\s-]?black\b/, "black"],
  [/\bjet[\s-]?black\b/, "black"],
  [/\bheather(?:ed)?[\s-]?gr[ae]y\b/, "grey"],
  [/\bgun[\s-]?metal\b/, "grey"],
  [/\b(?:army|military|forest|bottle|hunter|olive|kelly|sea|moss|mint|pine)[\s-]?green\b/, "green"],
  [/\bolive[\s-]?drab\b/, "green"],
  [/\b(?:sky|powder|ice|baby|royal|steel|cornflower|midnight|ocean|dusk|electric|denim|cadet)[\s-]?blue\b/, "blue"],
  [/\b(?:hot|baby|bubblegum|candy|dusty|ballet)[\s-]?pink\b/, "pink"],
  [/\bdusty[\s-]?ros[eé]\b/, "pink"],
  [/\bburnt[\s-]?(?:orange|sienna)\b/, "orange"],
  [/\bterra[\s-]?cotta\b/, "orange"],
  [/\bstone[\s-]?(?:grey|gray)\b/, "grey"],
  [/\bcamel[\s-]?brown\b/, "brown"],
  [/\b(?:brick|wine|blood|cherry|fire)[\s-]?red\b/, "red"],
  [/т[её]мно[\s-]?син|т[её]мно[\s-]?синій/, "blue"],
  [/слонов\p{L}*\s+кост/u, "white"],
  [/морск\p{L}*\s+волн/u, "blue"],
];

/**
 * Words that mean the piece is several colours rather than one — the truthful
 * label for a camo parka or a tie-dye tee is Multicolor, and until now those
 * landed in no colour group at all. Field-only: "Camo Cargo" in a *name* says
 * nothing certain about the colour field of the variant being imported.
 */
export const MULTICOLOUR_WORDS =
  /\b(?:multi[\s-]?colou?r(?:ed)?|multicolou?r(?:ed)?|multi|rainbow|tie[\s-]?dye(?:d)?|camo(?:uflage)?|kaleidoscope|patchwork|assorted)\b|многоцвет|разноцвет|мульти|камуфляж|різнокольор|багатокольор/i;

export function colourTermCounts(): { safe: number; field: number; qualifier: number; stems: number; phrases: number } {
  const alternatives = (list: [RegExp, Base][]) => list.reduce((n, [re]) => n + re.source.split("|").length, 0);
  return {
    safe: Object.keys(SAFE_COLOUR_WORDS).length,
    field: Object.keys(FIELD_COLOUR_WORDS).length,
    qualifier: Object.keys(QUALIFIER_COLOUR_WORDS).length,
    stems: alternatives(COLOUR_STEMS) + alternatives(FIELD_COLOUR_STEMS) + alternatives(QUALIFIER_COLOUR_STEMS),
    phrases: COLOUR_PHRASES.length,
  };
}
