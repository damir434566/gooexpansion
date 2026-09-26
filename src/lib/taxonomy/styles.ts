/**
 * The style dictionary: the words a product page uses that say what manner of
 * piece it is.
 *
 * The importer wrote `styleKeywords: []` for every product it had ever created:
 * the vocabulary existed, the pickers used it, and nothing filled it from a
 * page. The stylist reads these tags, so an empty column means a catalogue the
 * stylist cannot reason about beyond category and colour. `inferStyleKeywords`
 * fills it from the words a page already gives — the product's name, its
 * description, its material and the label the tree filed it under.
 *
 * Deliberately narrow. A style tag is a soft signal (a filter, a hint to the
 * stylist), so a missing one costs little and a wrong one teaches the stylist
 * something false about the piece. Words that name a garment rather than a
 * manner — "jacket", "dress" — are not here, and neither are colours: black is
 * not a style, and inferring "dark" from it would tag half the catalogue. A
 * garment word is here only where the garment *is* the style: a cargo pant is
 * utilitarian, a varsity jacket preppy, a tracksuit sporty.
 *
 * Also left out on purpose: brand lines that borrow a style word ("Heritage",
 * "Classic" as a model name is kept — the old rules had it and it is usually
 * right), and words that are a style in one sentence and a fit note in the
 * next ("basic", "simple", "smart", "urban", "breathable").
 *
 * ── Term syntax ── the garment dictionary's, so one reading serves both:
 *
 *   English  words compared whole, hyphens and punctuation read as spaces; the
 *            last word may carry a plural "s"/"es" unless it ends in "!".
 *   Cyrillic each word is a stem matched at the start of a word ("кружев" is
 *            кружево, кружевной, кружевная); "!" makes it exact.
 *   RegExp   run against the same normalised text (lowercase, "ё" → "е",
 *            non-letters → single spaces, padded with a space at each end).
 *
 * Every term is word-bounded. The rules this replaces were one regex per style
 * with `\b` only at the two ends of a long alternation, so "lace" matched
 * "necklace", "shoe laces" and the brand Palace, and "Lace-Up Derby Shoes" came
 * back romantic.
 */
import type { StyleKeyword } from "@/lib/types";
import { STYLE_KEYWORD_LIST } from "@/lib/style-keywords";

type Term = string | RegExp;

export const STYLE_TERMS: Record<StyleKeyword, readonly Term[]> = {
  "avant-garde": [
    "avant garde", "avantgarde", "deconstructed", "deconstruction", "reconstructed", "asymmetric",
    "asymmetrical", "asymmetry", "sculptural", "conceptual", "architectural", "experimental",
    "drop crotch", "dropped crotch", "exposed seam",
    "distorted", "cocoon silhouette", "avant", "wabi sabi",
    "авангард", "деконструк", "асимметр", "скульптурн", "концептуальн", "архитектурн",
    "экспериментальн", "заниженн шаг", "заниженн мотн", "асиметр", "архітектурн", "експериментальн",
  ],
  streetwear: [
    "streetwear", "street wear", "street style", "streetstyle", "skate", "skater", "skateboard",
    "skateboarding", "skatewear", "graffiti", "graphic tee", "graphic print", "graphic t shirt",
    "graphic hoodie", "hype", "hypebeast", "box logo", "puff print", "hip hop", "rap tee",
    "oversized graphic", "streetwise", "sneakerhead", "bmx",
    "стритвир", "стрит стайл", "уличн стил", "уличн мод", "скейт", "граффити", "хип хоп", "хайп",
    "вуличн стил", "вуличн мод", "графіті",
  ],
  utilitarian: [
    "utility", "utilitarian", "workwear", "work wear", "military", "combat", "tactical", "technical",
    "multi pocket", "multipocket", "cargo", "carpenter", "double knee", "chore coat",
    "chore jacket", "work jacket", "work pant", "work trouser", "work shirt", "work boot",
    "painter pant", "ripstop", "rip stop", "field jacket", "m 65", "m65", "m 51", "fishtail parka",
    "ma 1", "flight jacket", "army", "fatigue", "gorpcore", "gorp core", "hardwearing",
    "hard wearing", "heavy duty", "duck canvas", "overalls", "dungarees", "coverall", "boiler suit",
    "utility vest", "fishing vest", "hunting jacket", "bellows pocket", "paracord", "molle",
    "hiking", "trekking", "mountaineering", "expedition", "outdoor gear", "camouflage", "camo",
    "милитари", "карго", "тактическ", "утилитарн", "армейск", "камуфляж", "спецодежд", "горпкор",
    "рабоч брюк", "рабоч штан", "рабоч куртк", "рабоч комбинезон", "рабоч ботин", "полукомбинезон",
    "множеств карман", "много карман", "мілітарі", "тактичн", "армійськ", "робоч штан",
    "робоч куртк", "похідн", "трекингов", "треккингов",
  ],
  bohemian: [
    "bohemian", "boho", "boho chic", "crochet", "crocheted", "fringe", "fringed", "fringing", "paisley",
    "kaftan", "caftan", "peasant", "macrame", "macramé", "folk", "folkloric", "hippie", "hippy",
    "prairie", "ikat", "batik", "block print", "poncho", "festival", "tie dye", "tie dyed",
    "embroidered peasant", "gypsy skirt", "tassel trim", "suzani", "patchwork",
    "бохо", "богемн", "вязан крючком", "крючком!", "бахром", "пейсли", "огуречн", "кафтан",
    "этническ", "фолк", "хиппи", "макраме", "тай дай", "пончо", "пэчворк", "печворк", "крестьянск",
    "етнічн", "пейслі", "хіпі", "гачком!",
  ],
  preppy: [
    "preppy", "prep!", "varsity", "collegiate", "college", "argyle", "letterman", "pinstripe",
    "pinstriped", "rugby shirt", "rugby", "cable knit", "cable knitted", "cricket jumper",
    "cricket sweater", "tennis sweater", "boat shoe", "deck shoe", "ivy league", "ivy style",
    "letter patch", "chenille patch", "chenille letter", "crest", "crested", "blazer badge",
    "country club", "boarding school", "madras", "school uniform",
    "преппи", "колледж", "варсити", "аргайл", "регби", "университетск", "студенческ", "косами!", "узором косы",
    "преппі", "коледж", "регбі", "університетськ", "студентськ",
  ],
  academic: [
    "academic", "academia", "dark academia", "light academia", "tweed", "harris tweed", "donegal",
    "houndstooth", "hounds tooth", "dogtooth", "herringbone", "corduroy", "scholar", "scholarly",
    "professor", "tartan", "glen check", "glen plaid", "prince of wales", "elbow patch",
    "satchel", "bookish",
    "академическ", "академичн", "твид", "гусин лапк", "в елочку", "елочкой", "вельвет",
    "тартан", "шотландк", "клетк принц уэльск",
    "академічн", "твід", "гусяч лапк",
  ],
  sporty: [
    "sport", "sporty", "sportswear", "sports wear", "athletic", "athleisure", "performance",
    "running", "training", "track suit", "tracksuit", "track top",
    "track jacket", "track pant", "track trouser", "activewear", "active wear", "gym", "workout",
    "basketball", "football", "soccer", "tennis", "golf", "yoga", "pilates", "jogging", "jogger",
    "moisture wicking", "sweat wicking", "wicking", "dri fit", "drifit", "climalite", "aeroready",
    "heat rdy", "compression", "racing", "cycling", "marathon", "sweatband", "warm up", "sideline",
    "team kit", "matchday", "fitness", "crossfit", "hiit", "trail running", "ski", "skiing",
    "snowboard", "snowboarding", "swim training", "baseball", "volleyball", "badminton", "boxing",
    "martial art", "retro sport",
    "спорт", "спортивн", "атлетич", "атлетическ", "бегов", "для бега", "тренировоч", "фитнес", "пилатес", "баскетбол", "футбольн", "теннисн", "волейбол", "велосипедн",
    "велосипедк", "лыжн", "сноуборд", "для зала", "спорткостюм", "олимпийк", "компрессион", "йога!", "йоги!", "йогу!", "для йоги", "бокса!", "для бокса",
    "біг!", "бігов", "тренуван", "фітнес", "тенісн", "лижн",
  ],
  coastal: [
    "coastal", "nautical", "resort", "resortwear", "resort wear", "seersucker", "beachwear",
    "beach", "vacation", "holiday shop", "linen", "sailor", "mariniere", "marinière", "breton",
    "breton stripe", "yacht", "yachting", "riviera", "mediterranean", "cruise", "sailing",
    "boat shoe", "deck shoe", "raffia", "espadrille", "seaside", "hawaiian",
    "aloha", "cabana", "camp collar", "cuban collar", "resort collar", "terry towelling",
    "морск стил", "в морском стиле", "тельняшк", "бретонск", "пляж", "курорт", "для отпуска",
    "отпускн", "льнян", "лен!", "льна!", "яхт", "сирсакер", "матросск", "гавайск", "тропическ",
    "эспадриль", "рафи", "кубинск воротник",
    "морськ стил", "тільняшк", "пляжн", "курортн", "лляний", "лляна", "лляне", "лляні", "льон!",
    "гавайськ", "тропічн",
  ],
  romantic: [
    "romantic", "feminine", "floral", "florals", "flower print", "ditsy", /(?<= )lace(?! up )(?= )/u,
    "lace trim", "lace trimmed", "lacy", "ruffle", "ruffled", "frill", "frilled", "frilly",
    "bow detail", "bow tie detail", "chiffon", "broderie", "broderie anglaise", "eyelet",
    "puff sleeve", "puffed sleeve", "balloon sleeve", "sweetheart neckline", "tulle", "organza",
    "cottagecore", "milkmaid", "smocked", "smocking", "scalloped", "scallop", "ballet", "balletcore",
    "tiered", "rosette", "corsage", "pintuck", "pin tuck", "pleated chiffon", "georgette", "blouson sleeve",
    "романтич", "женствен", "цветочн", "в цветочек", "кружев", "рюш", "оборк", "волан", "шифон",
    "фатин", "органз", "бант", "рукав фонарик", "рукава фонарики", "фонарик",
    "шитье", "прошв", "корсетн", "ярус",
    "романтичн", "жіночн", "квітков", "квіточк", "мереживн", "мереживо", "ліхтарик",
  ],
  maximalist: [
    "maximalist", "maximalism", "eclectic", "statement piece", "statement print", "statement",
    "sequin", "sequinned", "sequined", "leopard", "animal print", "vibrant", "zebra", "zebra print",
    "tiger print", "snake print", "snakeskin print", "cheetah", "cow print", "all over print",
    "allover print", "embellished", "rhinestone", "crystal embellished", "beaded", "lamé",
    "lurex", "glitter", "neon", "psychedelic", "kaleidoscope", "clashing", "bold print", "baroque",
    "brocade", "marabou", "feather trim", "jewelled", "jeweled", "bejewelled", "bejeweled",
    "максимализ", "эклектич", "эклектик", "пайетк", "блестк", "глиттер", "леопард", "анималист",
    "зебр", "змеин принт", "тигров", "стразы!", "стразами", "люрекс", "неон", "барокко", "парч",
    "бисер", "расшит", "яркий принт", "ярким принтом", "кричащ",
    "максималіз", "еклектич", "паєтк", "анімалістич", "стрази!", "бісер", "яскрав принт",
  ],
  dark: [
    "gothic", "goth", "grunge", "punk", "darkwear", "distressed", "studded",
    "spiked", "skull", "occult", "pentagram", "emo", "post apocalyptic", "avant goth",
    "harness", "bondage", "metal band", "black metal", "doom", "witchy", "vampire", "horror",
    "barbed wire",
    "готик", "готическ", "гранж", "панк", "дарквир", "череп",
    "оккульт", "пентаграм", "эмо!", "портупе", "постапокалип", "ведьм",
    "готичн", "черепом", "черепами", "окульт",
  ],
  classic: [
    "classic", "timeless", "tailored", "tailoring", "refined", "elegant", "elegance",
    "trench", "loafer", "double breasted", "single breasted", "pocket square", "cufflink",
    "chesterfield", "sophisticated", "formal", "formalwear", "black tie", "tuxedo",
    "dinner jacket", "savile row", "bespoke", "made to measure", "old money", "quiet luxury",
    "gentleman", "gentlemen", "evening wear", "eveningwear", "wardrobe staple",
    "классическ", "классика!", "вне времени", "элегантн", "изысканн", "утонченн", "строг стил", "делов", "двубортн", "однобортн", "тренч", "лофер", "смокинг", "вечерн",
    "олд мани", "тихая роскош", "тихой роскош",
    "класичн", "класика!", "елегантн", "вишукан", "ділов", "двобортн", "смокінг", "вечірн",
  ],
  minimal: [
    "minimal", "minimalist", "minimalism", "minimalistic", "understated", "clean line", "clean lines",
    "essential", "essentials", "pared back", "sleek", "no logo", "logo free", "logoless", "unbranded",
    "monochrome", "monochromatic", "streamlined", "scandi", "scandinavian", "japandi",
    "capsule wardrobe", "unadorned", "stripped back", "clean design", "clean silhouette",
    "minimal design", "quiet design", "without logo",
    "минимализ", "минималист", "лаконичн", "без лишн", "сдержанн",
    "скандинавск", "без логотип", "монохром", "чистый силуэт", "чистые линии",
    "мінімаліз", "мінімаліст", "лаконічн", "стриман", "скандинавськ",
  ],
};

// ── Matching ─────────────────────────────────────────────────────────────────

/** Lowercase, "ё" → "е", every run of non-letters/digits one space, padded. */
function normalize(text: string): string {
  return ` ${(text ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

const isCyrillic = (s: string) => /[Ѐ-ӿ]/.test(s);

function compileWordTerm(raw: string): string {
  const cyrillic = isCyrillic(raw);
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const words: { text: string; exact: boolean }[] = [];
  for (const token of raw.toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(Boolean)) {
    const exact = token.endsWith("!");
    const parts = (exact ? token.slice(0, -1) : token)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    parts.forEach((text, i) => words.push({ text, exact: exact && i === parts.length - 1 }));
  }

  const pattern = words.map(({ text, exact }, i) => {
    const word = escape(text);
    if (cyrillic) return exact ? word : `${word}\\p{L}*`;
    return i === words.length - 1 && !exact ? `${word}(?:e?s)?` : word;
  });
  return ` ${pattern.join(" ")}(?= )`;
}

/**
 * One expression per style, its terms as alternatives: thirteen passes over a
 * description instead of seven hundred. The catalogue profile reads every
 * product's description with these, and did so in two seconds per three
 * thousand products one term at a time.
 */
const COMPILED: [StyleKeyword, RegExp][] = (Object.entries(STYLE_TERMS) as [StyleKeyword, readonly Term[]][])
  .map(([style, terms]) => {
    const alternatives = terms.map((term) => (term instanceof RegExp ? term.source : compileWordTerm(term)));
    return [style, new RegExp(`(?:${alternatives.join("|")})`, "u")];
  });

/** The first term of each style found in `text` — for "why was this tagged" answers. */
export function styleEvidence(text: string): Partial<Record<StyleKeyword, string>> {
  const hay = normalize(text);
  const out: Partial<Record<StyleKeyword, string>> = {};
  for (const [style, re] of COMPILED) {
    if (out[style]) continue;
    const m = re.exec(hay);
    if (m) out[style] = m[0].trim();
  }
  return out;
}

/**
 * The styles a product's own words imply, at most `max` of them.
 *
 * Returned in the vocabulary's order rather than the order they were found, so
 * two products tagged with the same pair read the same way — the same rule
 * `normalizeStyleKeywords` follows.
 */
export function inferStyleKeywords(text: string, max = 3): StyleKeyword[] {
  if ((text ?? "").trim().length < 3) return [];
  const found = new Set(Object.keys(styleEvidence(text)) as StyleKeyword[]);
  if (!found.size) return [];
  return STYLE_KEYWORD_LIST.filter((k) => found.has(k)).slice(0, max);
}

export function styleTermCounts(): { styles: number; english: number; cyrillic: number; patterns: number } {
  let english = 0, cyrillic = 0, patterns = 0;
  for (const terms of Object.values(STYLE_TERMS)) {
    for (const term of terms) {
      if (term instanceof RegExp) patterns++;
      else if (isCyrillic(term)) cyrillic++;
      else english++;
    }
  }
  return { styles: Object.keys(STYLE_TERMS).length, english, cyrillic, patterns };
}
