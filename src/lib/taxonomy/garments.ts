/**
 * The garment dictionary: what a piece is called, in the words shops use.
 *
 * The importer used to recognise a subcategory only by the label's own words —
 * "Bomber Jackets" matched a name containing "bomber" and "jacket", and nothing
 * else. So "MA-1 Flight Jacket", "Tee", "Trainers", "Beanie" and every Russian
 * title reached the catalogue without a subcategory, however plainly they said
 * what they were. This is the vocabulary that was missing: each garment type
 * with the names it goes by in English, Russian and Ukrainian, and where the
 * catalogue files it.
 *
 * ── How a title is read ──────────────────────────────────────────────────────
 *
 * A title usually names several garments, and only one of them is the piece:
 * "Pullover Hoodie", "Knit Dress", "Suit Jacket", "Fleece Vest". The piece is the
 * *head* of the phrase, and the two languages put it at opposite ends —
 *
 *   English puts it last:   "Pullover Hoodie" is a hoodie; "Knit Dress" a dress.
 *   Russian puts it first:  "Куртка-бомбер" is a jacket (of the bomber kind);
 *                           "Платье-рубашка" is a dress.
 *
 * So the category comes from the head — the match that ends last in an English
 * title, or starts first in a Cyrillic one — and a longer term beats a shorter
 * one at the same place ("suit jacket" over "jacket"). An English "with …"
 * clause lists extras, not the piece: "Skater Shorts with Keychain" is shorts.
 * The *label* is the head's own type, unless the head is a generic word: then
 * the most specific type that agrees with its category. "Reversible MA-1 Jacket"
 * ends on the generic "jacket", but MA-1 names the kind of jacket, so it files as
 * a bomber; "Belt Scarf" ends on a scarf, which is not a kind of belt.
 *
 * Weak terms (marked `~`) are words that are as often a fabric or a detail as a
 * garment — "knit", "denim", "fleece", "half zip". They count only when nothing
 * stronger is in the title, so "Henley Waffle Knit" is a henley and "Windbreaker
 * Half-Zip" a windbreaker, while "Tapered Denim" still reads as jeans.
 *
 * ── Term syntax ──────────────────────────────────────────────────────────────
 *
 *   English  words separated by spaces, compared whole; the last word may carry
 *            a plural "s"/"es". Hyphens and punctuation in both the term and the
 *            title become spaces, so "t shirt" matches "T-Shirt" and "ma 1"
 *            matches "MA-1". A leading "~" marks the term weak.
 *   Cyrillic each word is a *stem*, matched at the start of a word, because
 *            Russian and Ukrainian decline: "куртк" is куртка, куртки, куртку. A
 *            trailing "!" makes the word exact instead — "парка!" must not match
 *            "паркет".
 *   RegExp   for model numbers and other shapes a word list cannot say.
 *
 * ── Labels ───────────────────────────────────────────────────────────────────
 *
 * `labels` lists tree labels most specific first; the first one the tree
 * actually has is used. A loafer lists "Loafers" and "Dress Shoes": the default
 * tree has neither, so a loafer gets no label rather than a wrong one, and the
 * moment the admin adds "Loafers" in the studio, every loafer is filed there.
 */
import type { Category } from "@/lib/types";

type Term = string | RegExp;

export interface GarmentType {
  id: string;
  category: Category;
  labels: readonly string[];
  terms: readonly Term[];
}

const g = (
  id: string,
  category: Category,
  labels: readonly string[],
  terms: readonly Term[],
): GarmentType => ({ id, category, labels, terms });

/**
 * Listed most specific first within each category: when two types of the same
 * category both appear in a title, the earlier one is the label.
 */
export const GARMENT_TYPES: readonly GarmentType[] = [
  // ════════════════════════════════════════════════════════════════════════════
  // OUTERWEAR
  // ════════════════════════════════════════════════════════════════════════════
  g("bomber", "outerwear", ["Bomber Jackets", "Jackets"], [
    "bomber", "bomber jacket", "bomber coat", "flight jacket", "flight bomber", "pilot jacket",
    "aviator bomber", "ma 1", "ma1", "ma 1 jacket", "l 2b", "l2b", "cwu", "cwu 45p", "tanker jacket",
    "souvenir bomber", "varsity bomber", "satin bomber", "nylon bomber", "suede bomber",
    "бомбер", "куртк бомбер", "куртка-бомбер", "летная куртк", "летную куртк", "летной куртк",
    "пилот!", "пілот!",
  ]),
  g("raincoat", "outerwear", ["Raincoats", "Jackets"], [
    "raincoat", "rain coat", "rain jacket", "rain shell", "rain parka", "rain mac", "waterproof jacket",
    "waterproof coat", "hardshell", "hard shell", "hardshell jacket", "rain cape",
    "poncho", "rain poncho", "slicker", "oilskin", "gore tex jacket", "goretex jacket",
    "mountain jacket", "storm jacket", "stormshell", "3l jacket", "packable jacket",
    "дождевик", "плащ дождевик", "плащ-дождевик", "непромокаем куртк", "мембранн куртк",
    "пончо", "дощовик",
  ]),
  g("parka", "outerwear", ["Parkas", "Coats"], [
    "parka", "fishtail parka", "snorkel parka", "down parka", "arctic parka", "field parka",
    "m 51", "m51", "m 65 parka", "anorak", "pullover anorak", "anorak pullover", "anorak jacket",
    "парка!", "парки!", "парку!", "паркой!", "анорак", "аляск",
  ]),
  g("gilet", "outerwear", ["Vests", "Jackets"], [
    "gilet", "bodywarmer", "body warmer", "puffer vest", "down vest", "padded vest", "quilted vest",
    "insulated vest", "fleece vest", "utility vest", "tactical vest", "hunting vest", "fishing vest",
    "work vest", "safari vest", "shooting vest", "field vest", "liner vest", "reversible vest",
    "puffer gilet", "down gilet", "fleece gilet", "quilted gilet", "padded gilet",
    "жилет", "жилетк", "безрукавк", "дутый жилет", "пуховый жилет", "стёган жилет", "стеган жилет",
    "жилет утеплённ", "жилет утепленн", "жилет пухов",
  ]),
  g("biker", "outerwear", ["Biker Jackets", "Leather Jackets", "Jackets"], [
    "biker jacket", "biker", "moto jacket", "motorcycle jacket", "perfecto", "racer jacket",
    "cafe racer", "rider jacket", "riders jacket", "double rider",
    "косух", "мотокуртк", "байкерск куртк",
  ]),
  g("leather-jacket", "outerwear", ["Leather Jackets", "Jackets"], [
    "leather jacket", "leather jkt", "suede jacket", "shearling jacket", "sheepskin jacket", "aviator jacket",
    "b 3", "b3 jacket", "flying jacket",
    "кожан куртк", "замшев куртк", "куртк из кож", "шкур куртк",
  ]),
  g("denim-jacket", "outerwear", ["Denim Jackets", "Jackets"], [
    "denim jacket", "jean jacket", "trucker jacket", "trucker", "type i", "type ii", "type iii",
    "sherpa trucker", "chore denim jacket",
    "джинсов куртк", "джинсовк", "джинсова куртк",
  ]),
  g("puffer", "outerwear", ["Puffer Jackets", "Jackets"], [
    "puffer", "puffer jacket", "puffa", "down jacket", "padded jacket", "quilted jacket",
    "insulated jacket", "thermal jacket", "nuptse", "nuptse jacket", "micro puff", "nano puff",
    "down sweater", "liner jacket", "quilted liner", "ultra light down",
    "пуховик", "пухов куртк", "стёган куртк", "стеган куртк", "дут куртк", "утеплённ куртк",
    "утепленн куртк", "зимн куртк", "пуховік",
  ]),
  g("fleece-jacket", "outerwear", ["Fleece Jackets", "Jackets"], [
    "fleece jacket", "sherpa jacket", "sherpa fleece", "pile jacket", "pile fleece", "retro x",
    "denali", "polar fleece jacket", "zip up fleece", "fleece zip up", "full zip fleece",
    "флисов куртк", "флис куртк", "шерп куртк", "фліс",
  ]),
  g("track-jacket", "outerwear", ["Track Jackets", "Jackets"], [
    "track jacket", "track top", "tracksuit jacket", "tracksuit top", "firebird", "beckenbauer",
    "sst track", "warm up jacket", "warmup jacket", "tricot jacket",
    "олимпийк", "олімпійк", "спортивн куртк",
  ]),
  g("windbreaker", "outerwear", ["Windbreakers", "Jackets"], [
    "windbreaker", "wind breaker", "windcheater", "wind jacket", "windrunner", "wind shell",
    "shell suit jacket", "nylon jacket", "lightweight jacket", "~packable",
    "ветровк", "вітровк", "ветрозащитн куртк",
  ]),
  g("varsity", "outerwear", ["Varsity Jackets", "Jackets"], [
    "varsity jacket", "letterman jacket", "letterman", "stadium jacket", "college jacket",
    "baseball jacket", "award jacket",
    "бейсбольн куртк", "куртк варсити", "варсити",
  ]),
  g("workwear-jacket", "outerwear", ["Work Jackets", "Jackets"], [
    "chore jacket", "chore coat", "work jacket", "workwear jacket", "detroit jacket", "michigan coat",
    "og active jacket", "active jacket", "santa fe jacket", "barn jacket", "field jacket", "m 65",
    "m65", "m 65 jacket", "fatigue jacket", "utility jacket", "hunting jacket", "safari jacket",
    "engineer jacket", "railroad jacket", "painter jacket", "coverall jacket",
    "duck jacket", "canvas jacket", "waxed jacket", "wax jacket", "bedale", "beaufort", "ashby",
    "rancher jacket", "ranch jacket", "hunting coat",
    "рабоч куртк", "куртк рабоч", "полев куртк", "куртк м 65", "вощён куртк", "вощен куртк",
    "куртк сафари", "куртк милитари",
  ]),
  g("harrington", "outerwear", ["Harrington Jackets", "Jackets"], [
    "harrington", "harrington jacket", "g9", "golf jacket", "coach jacket", "coaches jacket",
    "blouson", "zip blouson", "souvenir jacket", "sukajan", "suka jacket", "tour jacket",
    "crew jacket", "team jacket", "shop jacket", "mechanic jacket", "work blouson",
    "харрингтон", "куртк харрингтон", "блузон", "куртк коуч", "сукаджан",
  ]),
  g("jacket", "outerwear", ["Jackets"], [
    "jacket", "jacket coat", "outer jacket", "overjacket", "hooded jacket", "zip jacket", "short jacket",
    "cropped jacket", "crinkle jacket", "shell jacket", "jkt", "jckt",
    "veste", "giacca", "giubbotto", "chaqueta", "cazadora", "jacke",
    "куртк", "курточк", "куртка!",
  ]),
  // Coats come after jackets on purpose: "Chore Coat" and "Car Coat" are listed
  // above as jackets-of-a-kind or here as coats by their full names, and the
  // generic "coat" must lose to both.
  g("trench", "outerwear", ["Trench Coats", "Coats"], [
    "trench", "trench coat", "trenchcoat", "mac", "mac coat", "mackintosh", "macintosh", "gabardine coat",
    "belted coat", "storm coat", "balmacaan", "bal collar coat",
    "тренч", "тренчкот", "плащ", "плащ тренч",
  ]),
  g("peacoat", "outerwear", ["Peacoats", "Coats"], [
    "peacoat", "pea coat", "reefer", "reefer jacket", "reefer coat", "pilot coat", "officer coat",
    "naval coat", "p coat", "melton coat", "duffle coat", "duffel coat", "toggle coat", "montgomery",
    "бушлат", "полупальто", "дафлкот", "дафл кот", "пальто дафлкот",
  ]),
  g("shearling-coat", "outerwear", ["Shearling Coats", "Coats"], [
    "shearling coat", "sheepskin coat", "fur coat", "faux fur coat", "teddy coat", "~shearling",
    "~sheepskin", "mouton coat", "afghan coat",
    "дублёнк", "дубленк", "шуб", "полушубок", "шубк", "дублянк",
  ]),
  g("overcoat", "outerwear", ["Overcoats", "Coats"], [
    "overcoat", "topcoat", "top coat", "greatcoat", "great coat", "chesterfield", "chesterfield coat",
    "crombie", "car coat", "polo coat", "wrap coat", "cocoon coat", "longline coat", "long coat",
    "tailored coat", "wool coat", "cashmere coat", "double breasted coat", "single breasted coat",
    "officer's coat", "cape coat", "opera coat",
    "пальто", "пальт", "полупальт",
  ]),
  g("cape", "outerwear", ["Capes", "Coats"], [
    "cape", "capelet", "cloak", "poncho cape", "shawl coat",
    "накидк", "кейп", "пелерин",
  ]),
  g("coat", "outerwear", ["Coats"], [
    "coat", "outer coat", "long coat",
    "manteau", "cappotto", "abrigo", "mantel",
    "пальто!",
  ]),
  g("outerwear", "outerwear", [], [
    "~outerwear", "~shell", "~outer layer",
    "~верхн одежд", "~верхній одяг",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // TAILORING
  // ════════════════════════════════════════════════════════════════════════════
  g("blazer", "blazers", ["Blazers"], [
    "blazer", "sport coat", "sportcoat", "sports coat", "sport jacket", "sports jacket", "suit jacket",
    "tailored jacket", "tuxedo jacket", "dinner jacket", "smoking jacket", "smoking", "tuxedo",
    "tux", "evening jacket", "boating blazer", "unstructured jacket", "deconstructed jacket",
    "double breasted jacket", "single breasted jacket", "db jacket", "sb jacket", "jacket blazer",
    "nehru jacket", "mandarin jacket", "safari blazer", "norfolk jacket", "hacking jacket",
    "пиджак", "піджак", "блейзер", "жакет", "смокинг", "фрак", "пиджак однобортн", "пиджак двубортн",
  ]),
  g("waistcoat", "blazers", ["Waistcoats", "Blazers"], [
    "waistcoat", "suit vest", "tailored vest", "vest waistcoat", "tuxedo vest", "dress vest",
    "жилет костюмн", "жилетк костюмн", "классическ жилет",
  ]),
  g("suit", "blazers", ["Suits", "Blazers"], [
    "suit", "two piece suit", "three piece suit", "2 piece suit", "3 piece suit", "tailored suit",
    "wool suit", "linen suit", "tuxedo suit", "trouser suit", "pantsuit", "pant suit",
    "костюм!", "костюм классическ", "костюм двойк", "костюм тройк", "брючн костюм",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // KNITWEAR — before tops, so a knitted polo or a sweater vest is knitwear
  // ════════════════════════════════════════════════════════════════════════════
  g("cardigan", "knitwear", ["Cardigans", "Knitwear"], [
    "cardigan", "cardi", "knit cardigan", "varsity cardigan", "shawl cardigan", "zip cardigan",
    "knit jacket", "sweater jacket", "knitted jacket", "knit coat",
    "кардиган", "кардіган", "вязан куртк", "вязан жакет",
  ]),
  g("sweater-vest", "knitwear", ["Sweater Vests", "Knitwear"], [
    "sweater vest", "knit vest", "knitted vest", "slipover", "tank sweater", "jumper vest", "vest sweater",
    "вязан жилет", "трикотажн жилет", "жилет вязан", "жилет трикотажн",
  ]),
  g("turtleneck", "knitwear", ["Turtlenecks", "Knitwear"], [
    "turtleneck", "turtle neck", "roll neck", "rollneck", "polo neck", "funnel neck", "mock neck",
    "mockneck", "high neck sweater", "roll neck sweater", "roll neck knit", "polo neck jumper",
    "водолазк", "гольф!", "гольфик",
  ]),
  g("knit-polo", "knitwear", ["Knit Polos", "Polo Shirts", "Knitwear"], [
    "knit polo", "knitted polo", "polo knit", "polo sweater", "knit polo shirt", "sweater polo",
    "вязан поло", "трикотажн поло", "поло вязан",
  ]),
  g("sweater", "knitwear", ["Sweaters", "Knitwear"], [
    "sweater", "jumper", "pullover", "knit sweater", "knit jumper", "crewneck sweater",
    "crew neck sweater", "v neck sweater", "v neck jumper", "vneck", "cable knit", "cable knit sweater",
    "fisherman sweater", "fishermans sweater", "aran sweater", "aran", "gansey", "guernsey",
    "fair isle", "fair isle sweater", "nordic sweater", "shetland", "lambswool sweater",
    "merino sweater", "cashmere sweater", "mohair sweater", "alpaca sweater", "chunky knit",
    "boucle knit", "knitwear", "knit top", "knitted top", "knit sweatshirt", "crewneck knit",
    "crew knit", "henley sweater", "half zip sweater", "quarter zip sweater", "zip knit",
    "свитер", "светр", "джемпер", "пуловер", "кофт", "свитерок", "трикотаж", "вязан свитер",
  ]),
  g("knit", "knitwear", ["Knitwear"], [
    "~knit", "~knitted", "~knits", "~knitwear",
    "~вязан", "~трикотажн", "~вязка",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // SHIRTS
  // ════════════════════════════════════════════════════════════════════════════
  g("overshirt", "shirts", ["Overshirts", "Shirts"], [
    "overshirt", "over shirt", "overshirt jacket", "shacket", "shacket jacket", "shirt jacket", "shirt jac", "cpo shirt", "cpo jacket",
    "shirt jacket wool", "flannel overshirt", "wool overshirt", "quilted overshirt",
    "рубашк куртк", "куртк рубашк", "куртка-рубашка", "рубашка-куртка", "овершот", "овершёрт",
    "сорочка-куртка",
  ]),
  g("shirt", "shirts", ["Shirts"], [
    "shirt", "button down", "button down shirt", "button up", "button up shirt", "oxford shirt",
    "~oxford", "ocbd", "dress shirt", "formal shirt", "poplin shirt", "~poplin", "flannel shirt",
    "~flannel", "chambray shirt", "~chambray", "denim shirt", "western shirt", "work shirt",
    "camp collar shirt", "camp shirt", "cuban collar shirt", "cuban shirt", "resort shirt",
    "bowling shirt", "hawaiian shirt", "aloha shirt", "short sleeve shirt", "long sleeve shirt",
    "linen shirt", "silk shirt", "tuxedo shirt", "grandad shirt", "grandad collar", "band collar shirt",
    "mandarin collar shirt", "popover shirt", "check shirt", "plaid shirt", "striped shirt",
    "utility shirt", "military shirt", "safari shirt", "guayabera", "kurta shirt",
    "chemise", "camicia", "camisa", "hemd",
    "рубашк", "сорочк", "рубашечк", "рубаха",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // TOPS
  // ════════════════════════════════════════════════════════════════════════════
  g("hoodie", "tops", ["Hoodies", "Hoodies & Sweatshirts"], [
    "hoodie", "hoody", "hooded sweatshirt", "hooded sweat", "hooded top", "zip hoodie", "zip up hoodie",
    "full zip hoodie", "pullover hoodie", "hooded pullover", "hooded fleece", "tech fleece hoodie",
    "box logo hoodie", "hooded jumper", "sweat a capuche", "felpa con cappuccio", "sudadera con capucha",
    "худи", "худі", "толстовк", "кенгуру", "худи на молнии", "толстовк с капюшон",
  ]),
  g("sweatshirt", "tops", ["Sweatshirts", "Hoodies & Sweatshirts"], [
    "sweatshirt", "sweat shirt", "sweat", "crewneck sweatshirt", "crew neck sweatshirt",
    "crew sweatshirt", "crew sweat", "crewneck sweat", "fleece pullover", "fleece top",
    "fleece crewneck", "half zip sweatshirt", "quarter zip sweatshirt", "half zip fleece",
    "quarter zip fleece", "track sweatshirt", "raglan sweatshirt", "loopback", "french terry top",
    "felpa", "sudadera",
    "свитшот", "світшот", "толстовк без капюшон", "спортивн кофт",
  ]),
  // A zip-through top is usually a hoodie without the word; a half zip, a sweatshirt.
  g("zip-up", "tops", ["Hoodies", "Hoodies & Sweatshirts"], [
    "~full zip", "~zip up", "~zip through",
    "~на! молни",
  ]),
  g("half-zip", "tops", ["Sweatshirts", "Hoodies & Sweatshirts"], [
    "~half zip", "~quarter zip", "~1 4 zip",
    "~полузамок",
  ]),
  g("polo", "tops", ["Polo Shirts", "Polos"], [
    "polo", "polo shirt", "pique polo", "piqué polo", "polo tee", "tennis polo", "golf polo",
    "long sleeve polo", "rugby shirt", "rugby", "rugby top", "rugby polo",
    "поло!", "футболк поло", "рубашк поло", "регбийк", "поло-футболка",
  ]),
  g("henley", "tops", ["Henleys"], [
    "henley", "henley shirt", "henley tee", "grandad tee", "placket tee",
    "хенли", "генли",
  ]),
  g("tank", "tops", ["Tank Tops", "Tanks"], [
    "tank top", "tank", "tanktop", "muscle tank", "muscle tee", "sleeveless tee", "sleeveless top",
    "singlet", "vest top", "racerback", "racer back tank", "ribbed tank",
    "майка!", "майки!", "майку!", "майкой!", "майка-алкоголичк", "борцовк", "топ на бретел",
  ]),
  g("camisole", "tops", ["Camisoles", "Tank Tops"], [
    "camisole", "cami", "cami top", "slip top", "strappy top", "spaghetti strap top",
    "топ на тонк бретел", "комбинаци топ",
  ]),
  g("longsleeve", "tops", ["Long Sleeves", "Longsleeves", "Long Sleeve T-Shirts", "T-Shirts"], [
    "longsleeve", "long sleeve", "long sleeve tee", "long sleeve t shirt", "long sleeved t shirt",
    "long sleeved tee", "ls tee", "l s tee", "l s t shirt", "ls t shirt", "l s top", "longsleeve tee",
    "long sleeve top",
    "лонгслив", "лонгслів", "футболк с длинн рукав",
  ]),
  g("tshirt", "tops", ["T-Shirts"], [
    "t shirt", "tshirt", "tee", "tee shirt", "graphic tee", "logo tee", "pocket tee", "ringer tee",
    "raglan tee", "baseball tee", "boxy tee", "oversized tee", "heavyweight tee", "basic tee",
    "crew tee", "v neck tee", "vneck tee", "v neck t shirt", "crew neck t shirt", "s s tee",
    "short sleeve tee", "short sleeve t shirt", "band tee", "tour tee", "souvenir tee", "jersey tee",
    "футболк", "футболочк", "футболк оверсайз", "тишк",
  ]),
  g("blouse", "tops", ["Blouses"], [
    "blouse", "pussy bow blouse", "peasant blouse", "wrap blouse", "silk blouse", "shirt blouse",
    "блуз", "блузк",
  ]),
  g("bodysuit", "tops", ["Bodysuits"], [
    "bodysuit", "body suit", "leotard", "thong bodysuit",
    "боди!", "боді!",
  ]),
  g("bralette", "tops", ["Bralettes", "Crop Tops"], [
    "bralette", "bralet", "bra top", "sports bra",
    "бралет", "бра топ", "спортивн бра", "спортивн топ-бра",
  ]),
  g("crop-top", "tops", ["Crop Tops"], [
    "crop top", "cropped top", "bandeau", "bandeau top", "tube top",
    "halter top", "halterneck top", "corset top", "bustier", "bustier top",
    "кроп топ", "кроп-топ", "корсет", "бюстье", "топ бандо",
  ]),
  g("tunic", "tops", ["Tunics", "Blouses"], [
    "tunic", "kurta", "kaftan top", "smock top",
    "туник",
  ]),
  g("jersey", "tops", ["Jerseys", "T-Shirts"], [
    "football jersey", "soccer jersey", "basketball jersey", "hockey jersey", "baseball jersey",
    "cycling jersey", "team jersey", "replica jersey", "match jersey", "~jersey",
    "футбольн футболк", "игров футболк", "джерси!",
  ]),
  g("crewneck", "tops", [], [
    "~crewneck", "~crew neck",
  ]),
  g("top", "tops", [], [
    "~top", "~tops", "~vest",
    "~топ!", "~топы!",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // JEANS — before trousers, so "carpenter jeans" is jeans and not a carpenter pant
  // ════════════════════════════════════════════════════════════════════════════
  g("jeans", "jeans", ["Jeans"], [
    "jeans", "denims", "fit jean", "slim jean", "straight jean", "skinny jean", "relaxed jean",
    "tapered jean", "wide jean", "loose jean", "baggy jean", "flare jean", "bootcut jean", "regular jean", "straight jeans", "slim jeans", "skinny jeans", "wide jeans",
    "baggy jeans", "loose jeans", "bootcut", "boot cut", "flare jeans", "flared jeans", "mom jeans",
    "dad jeans", "boyfriend jeans", "carpenter jeans", "~selvedge", "~selvage", "~raw denim", "501", "levis 501", "levi s 501",
    "rigid denim", "denim pant", "denim trousers", "5 pocket jeans",
    "five pocket", "5 pocket", "tapered jeans", "barrel jeans", "balloon jeans", "cargo jeans", "~flare",
    "vaqueros",
    "джинсы!", "джинсов!", "джинсах!", "джинсами!", "джинси!", "джинсы клёш", "джинсы-клёш", "бойфренды", "мом джинс", "скинни", "клёш",
  ]),
  g("denim", "jeans", ["Jeans"], [
    "~denim",
    "~деним",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // SHORTS — before trousers and swimwear: "swim shorts" are shorts
  // ════════════════════════════════════════════════════════════════════════════
  g("shorts", "shorts", ["Shorts"], [
    "shorts", "bermuda", "bermudas", "bermuda shorts", "cargo short", "chino short",
    "denim short", "jean short", "jorts", "cut off short", "cutoffs", "board short", "boardshorts",
    "swim short", "swimming short", "running short", "training short", "gym short",
    "basketball short", "sweat short", "fleece short", "cycling short", "bike short",
    "biker short", "hot pants", "hotpants", "culotte short", "pleated short", "work short",
    "carpenter short", "painter short", "hiking short", "tennis short", "football short",
    "bermuda short", "linen short", "nylon short", "mesh short", "utility short",
    "шорт", "шорти", "бермуд", "велосипедк", "плавательн шорт", "купальн шорт", "шорты карго",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // SWIMWEAR
  // ════════════════════════════════════════════════════════════════════════════
  g("swimwear", "swimwear", ["Swimwear"], [
    "swimsuit", "swim suit", "swimwear", "bathing suit", "one piece swimsuit", "bikini", "bikini top",
    "bikini bottom", "bikini bottoms", "tankini", "monokini", "swim trunks", "trunks", "swim brief",
    "swim briefs", "speedo", "rash guard", "rashguard", "rash vest", "swim top", "beachwear",
    "купальник", "плавк", "бикини", "плавки-шорты", "купальн", "танкини",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // TROUSERS
  // ════════════════════════════════════════════════════════════════════════════
  g("cargo", "bottoms", ["Cargo Pants", "Pants"], [
    "cargo pants", "cargo pant", "cargo trousers", "cargos", "combat pants", "combat trousers",
    "fatigue pants", "fatigue pant", "fatigues", "military pants", "army pants", "utility pants",
    "tactical pants", "bdu pants", "parachute pants", "parachute pant", "para pants",
    "брюки карго", "штаны карго", "карго!", "брюк милитари", "штан парашют", "брюки парашют",
  ]),
  g("workpant", "bottoms", ["Work Pants", "Pants"], [
    "carpenter pants", "carpenter pant", "carpenter trousers", "painter pants", "painter pant",
    "work pants", "work pant", "work trousers", "double knee", "double knee pant", "double knee pants",
    "duck pants", "canvas pants", "utility trousers", "chore pants", "fatigue trousers", "overpants",
    "рабоч брюк", "рабоч штан", "брюки плотник",
  ]),
  g("jogger", "bottoms", ["Joggers", "Pants"], [
    "joggers", "jogger", "jogger pants", "sweatpants", "sweat pants", "sweatpant", "sweat pant",
    "track pants", "track pant", "trackpants", "tracksuit bottoms", "tracksuit pants", "track bottoms",
    "fleece pants", "fleece joggers", "tech fleece joggers", "training pants", "running pants",
    "lounge pants", "jog pants", "jogging pants", "jogging bottoms", "sweat bottoms", "tracksuit",
    "джоггер", "джогер", "спортивн штан", "спортивн брюк", "треники", "трениров штан", "спортивки",
  ]),
  g("leggings", "bottoms", ["Leggings", "Pants"], [
    "leggings", "legging", "tights", "yoga pants", "flare leggings", "running tights", "cycling tights",
    "meggings",
    "легинс", "лосин", "леггинс", "легінс", "колготк",
  ]),
  g("chino", "bottoms", ["Chinos", "Pants"], [
    "chinos", "chino", "chino pants", "chino trousers", "khakis", "khaki pants",
    "чинос", "чиносы", "брюк чинос",
  ]),
  g("trousers", "bottoms", ["Pants"], [
    "trousers", "trouser", "pants", "pant", "slacks", "tailored trousers", "tailored pants", "pleated trousers",
    "pleated pants", "wide leg trousers", "wide leg pants", "straight leg trousers", "flared trousers",
    "flare pants", "flared pants", "palazzo", "palazzo pants", "culottes", "culotte", "cigarette trousers",
    "cigarette pants", "tapered trousers", "suit trousers", "dress pants", "wool trousers",
    "linen trousers", "linen pants", "drawstring trousers", "drawstring pants", "harem pants",
    "baggy pants", "bell bottoms", "capri", "capri pants", "gurkha trousers", "sailor pants",
    "pantalon", "pantaloni", "pantalones",
    "брюк", "штан", "штани", "брючк", "палаццо", "кюлот", "брюки со стрелк", "брюки широк",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // SKIRTS
  // ════════════════════════════════════════════════════════════════════════════
  g("skirt", "skirts", ["Skirts"], [
    "skirt", "mini skirt", "miniskirt", "midi skirt", "maxi skirt", "pleated skirt", "a line skirt",
    "pencil skirt", "slip skirt", "wrap skirt", "tennis skirt", "cargo skirt", "denim skirt",
    "tiered skirt", "tulle skirt", "kilt", "skort", "sarong", "sarong skirt", "tutu",
    "jupe", "gonna", "falda",
    "юбк", "спідниц", "юбка-карандаш", "юбка плиссе", "килт", "юбка шорт", "саронг",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // DRESSES & ONE-PIECES
  // ════════════════════════════════════════════════════════════════════════════
  g("dress", "dresses", ["Dresses"], [
    "dress", "mini dress", "midi dress", "maxi dress", "slip dress", "shirt dress", "shirtdress",
    "t shirt dress", "tee dress", "wrap dress", "sweater dress", "knit dress", "jumper dress",
    "shift dress", "sheath dress", "bodycon dress", "cocktail dress", "evening dress", "gown",
    "ball gown", "evening gown", "sundress", "sun dress", "tea dress", "smock dress", "pinafore",
    "pinafore dress", "polo dress", "hoodie dress", "sweatshirt dress", "corset dress", "frock",
    "kaftan", "caftan", "cheongsam", "qipao", "prairie dress", "babydoll dress", "tunic dress", "robe longue",
    "vestido", "kleid",
    "плать", "сукн", "сарафан", "платье-рубашк", "платье-комбинаци", "платье-футболк", "вечерн плать",
  ]),
  g("jumpsuit", "jumpsuits", ["Jumpsuits"], [
    "jumpsuit", "playsuit", "romper", "boilersuit", "boiler suit", "coverall", "coveralls",
    "flight suit", "catsuit", "unitard", "overalls", "overall", "dungarees", "dungaree", "bib overalls",
    "bib pants", "onesie", "siren suit", "utility suit", "work suit",
    "комбинезон", "полукомбинезон", "ромпер", "комбинезон джинсов", "комбінезон",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // FOOTWEAR
  // Model names first: they name the shoe without any shoe word, and "Nike
  // Blazer" must be a sneaker before the tailoring "blazer" is considered.
  // ════════════════════════════════════════════════════════════════════════════
  g("sneaker-model", "footwear", ["Sneakers"], [
    "air force 1", "air force one", "af1", "air max", "air max 1", "air max 90", "air max 95",
    "air max 97", "air max plus", "vapormax", "air jordan", "jordan 1", "jordan 3", "jordan 4",
    "jordan 5", "jordan 11", "aj1", "aj4", "dunk", "dunk low", "dunk high", "sb dunk", "nike blazer",
    "blazer mid", "blazer low", "cortez", "pegasus", "vomero", "p 6000", "shox", "air rift",
    "air huarache", "killshot", "zoom vomero", "air presto", "presto", "tailwind",
    "samba", "gazelle", "superstar", "stan smith", "forum low", "forum 84", "forum mid", "campus 00s",
    "campus 80s", "spezial",
    "handball spezial", "sl 72", "sl72", "ozweego", "nmd", "ultraboost", "ultra boost", "adizero",
    "yeezy boost", "yeezy 350", "yeezy 700", "foam runner", "taekwondo",
    /\bnew balance\s*\d{3,4}[a-z0-9]*\b/, /\bnb\s*\d{3,4}\b/, "2002r", "1906r", "9060", "990v6",
    "990v5",
    "gel lyte", "gel kayano", "gel nyc", "gel 1130", "gel 1090", "gt 2160", "mexico 66", "onitsuka tiger",
    "xt 6", "speedcross", "xt wings", "acs pro", "clifton", "bondi", "mafate",
    "chuck taylor", "chuck 70", "chuck taylor all star", "converse all star", "run star", "one star", "jack purcell",
    "old skool", "sk8 hi", "half cab", "knu skool", "slip on vans",
    "club c", "reebok classic", "workout plus", "instapump", "question mid",
    "puma suede", "palermo", "speedcat", "mayze",
    "achilles low", "common projects", "b23", "b22", "b27", "track sneaker", "triple s", "runner sneaker",
    "gt 1000", "cloudmonster", "cloudtilt", "cloud 5", "cloudnova", /\bd3 (?:og|2001|xt)\b/,
    "zapatillas",
  ]),
  g("boot-model", "footwear", ["Boots"], [
    "1460", "1461", "2976", "jadon", "101 boot", "6 inch boot", "6 inch premium", "yellow boot",
    "blundstone", "wallabee boot", "desert boot", "tasman", "ugg", "uggs",
    "moc toe", "iron ranger", "beckman", "engineer boot", "harness boot",
  ]),
  g("sandal-model", "footwear", ["Sandals"], [
    "arizona", "gizeh", "mayari", "milano sandal", "madrid sandal", "birkenstock",
    "adilette", "chaco", "teva", "yeezy slide",
  ]),
  g("boots", "footwear", ["Boots"], [
    "boots", "boot", "chelsea boot", "chelsea boots", "chelsea", "combat boot", "combat boots",
    "lace up boot", "lace up boots", "work boot", "work boots", "hiking boot", "hiking boots",
    "trekking boot", "chukka", "chukka boot", "desert boots", "cowboy boot", "cowboy boots",
    "western boot", "western boots", "ankle boot", "ankle boots", "knee high boot", "knee high boots",
    "over the knee boots", "thigh high boots", "biker boot", "biker boots", "motorcycle boots",
    "engineer boots", "rain boot", "rain boots", "wellies", "wellington boots", "rubber boots",
    "snow boot", "snow boots", "winter boots", "apres ski boots", "moon boot", "duck boot",
    "platform boot", "platform boots", "jodhpur boot", "riding boot", "zip boot", "sock boot",
    "booties", "bootie", "ugg boot", "shearling boot", "mountain boot", "military boot", "jungle boot",
    "bottes", "stivali", "botas", "stiefel",
    "ботинк", "черевик", "сапог", "чобіт", "чоботи", "челси", "берц", "казак", "угг", "уггі", "дутик",
    "полусапог", "ботильон", "дезерт", "чукк", "мартинс", "тимберленд",
  ]),
  g("sandals", "footwear", ["Sandals"], [
    "sandals", "sandal", "slides", "slide", "pool slides", "slide sandals", "sliders", "flip flops",
    "flip flop", "flipflops", "thongs sandals", "fisherman sandals", "gladiator sandals", "sport sandals",
    "hiking sandals", "strappy sandals", "footbed sandals", "clog sandals", "espadrille sandals",
    "platform sandals", "wedge sandals", "jelly sandals", "huaraches", "geta",
    "sandales", "sandali", "sandalias",
    "сандал", "босоножк", "шлёпанц", "шлепанц", "сланц", "вьетнамк", "шльопанц", "в'єтнамк",
    "слайды", "слайдер", "шлёпки", "шлепки",
  ]),
  g("sneakers", "footwear", ["Sneakers"], [
    "sneakers", "sneaker", "trainers", "trainer", "runners", "runner", "running shoes", "running shoe",
    "tennis shoes", "tennis shoe", "court shoe sneaker", "skate shoes", "skate shoe", "basketball shoes",
    "basketball shoe", "training shoes", "gym shoes", "athletic shoes", "plimsolls", "plimsoll",
    "canvas shoes", "high tops", "high top", "hi tops", "hi top", "low tops", "low top", "mid top",
    "low top sneakers", "high top sneakers", "trail shoes", "trail runners", "trail running shoes",
    "approach shoes", "walking shoes", "dad shoes", "chunky sneakers", "retro runner", "retro running",
    "кроссовк", "кросівк", "кроссы!", "кеды", "кед!", "кеди", "сникер", "снікер", "беговые кроссовк",
    "слипон",
  ]),
  g("loafers", "footwear", ["Loafers", "Dress Shoes"], [
    "loafers", "loafer", "penny loafer", "penny loafers", "tassel loafer", "tassel loafers",
    "horsebit loafer", "horsebit loafers", "bit loafer", "driving shoes", "drivers", "driving moccasin",
    "moccasins", "moccasin", "boat shoes", "boat shoe", "deck shoes", "slip on loafers", "belgian loafer",
    "лофер", "лоферы", "мокасин", "топсайдер", "драйвер", "слиперы", "слипер",
  ]),
  g("dress-shoes", "footwear", ["Dress Shoes"], [
    "oxford shoes", "oxford shoe", "oxfords", "cap toe oxford", "derby", "derbies", "derby shoes",
    "derby shoe", "brogues", "brogue", "wingtip", "wingtips", "monk strap", "monk straps",
    "double monk", "monk shoes", "dress shoes", "dress shoe", "blucher", "bluchers", "whole cut",
    "wholecut", "formal shoes", "lace up shoes", "leather shoes",
    "туфл", "дерби", "оксфорд", "броги", "монки", "монк", "оксфорды",
  ]),
  g("mules", "footwear", ["Mules", "Clogs"], [
    "mules", "mule", "backless loafer", "slide mules", "clogs", "clog", "sabot", "sabots", "crocs",
    "classic clog", "boston clog",
    "мюли", "мюль", "сабо", "клог", "клоги",
  ]),
  g("heels", "footwear", ["Heels"], [
    "heels", "heel", "pumps", "pump", "court shoes", "court shoe", "opera pumps", "stilettos", "stiletto", "slingbacks", "slingback", "kitten heels",
    "kitten heel", "block heels", "platform heels", "wedges", "wedge", "court heels", "mary janes",
    "mary jane",
    "туфли на каблук", "каблук", "лодочк", "шпильк", "танкетк", "мэри джейн",
  ]),
  g("flats", "footwear", ["Flats"], [
    "ballet flats", "ballet flat", "flats", "ballerinas", "ballerina", "ballet pumps", "pointed flats",
    "балетк", "балетки", "лоферы-балетки",
  ]),
  g("espadrilles", "footwear", ["Espadrilles", "Flats"], [
    "espadrilles", "espadrille",
    "эспадриль", "еспадриль",
  ]),
  g("slippers", "footwear", ["Slippers"], [
    "slippers", "slipper", "house shoes", "scuffs",
    "тапочк", "тапк", "домашн тапочк",
  ]),
  g("shoes", "footwear", [], [
    "shoes", "shoe", "~footwear", "chaussure", "scarpe", "zapatos", "schuhe",
    "обувь", "взутт",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // BAGS — a bag word is the head even after a shoe or a laptop: "Shoe Bag"
  // ════════════════════════════════════════════════════════════════════════════
  g("backpack", "bags", ["Backpacks", "Bags"], [
    "backpack", "back pack", "rucksack", "daypack", "day pack", "roll top backpack", "rolltop",
    "laptop backpack", "hiking backpack", "knapsack", "school bag", "bookbag",
    "sac a dos", "sac à dos", "zaino", "mochila",
    "рюкзак", "ранец", "наплечн рюкзак",
  ]),
  g("tote", "bags", ["Tote Bags", "Bags"], [
    "tote", "tote bag", "shopper", "shopper bag", "shopping bag", "market bag", "beach bag",
    "canvas tote", "book tote", "carryall",
    "тоут", "шоппер", "шопер", "сумка-тоут", "сумка-шоппер", "сумк шоппер",
  ]),
  g("crossbody", "bags", ["Crossbody Bags", "Bags"], [
    "crossbody", "cross body", "crossbody bag", "cross body bag", "sling bag", "sling", "messenger",
    "messenger bag", "shoulder bag", "saddle bag", "camera bag", "phone bag", "pouch bag",
    "mini bag", "flap bag", "baguette", "baguette bag", "hobo", "hobo bag", "bucket bag", "satchel",
    "handbag", "hand bag", "top handle bag", "top handle", "half moon bag", "crescent bag",
    "сумк через плеч", "сумк-кросс", "кросс-боди", "кроссбоди", "мессенджер", "сумк почтальон",
    "сумк седл", "сумк-багет", "сумк хобо", "сумк-мешок", "сумочк",
  ]),
  g("belt-bag", "bags", ["Belt Bags", "Bags"], [
    "belt bag", "waist bag", "bum bag", "fanny pack", "hip bag", "hip pack", "waist pack", "chest bag",
    "chest rig", "sling pack",
    "поясн сумк", "сумк на пояс", "бананк", "нагрудн сумк",
  ]),
  g("clutch", "bags", ["Clutches", "Bags"], [
    "clutch", "clutch bag", "evening bag", "envelope clutch", "pouch", "wristlet", "minaudiere",
    "клатч", "косметичк", "пенал!",
  ]),
  g("travel-bag", "bags", ["Travel Bags", "Bags"], [
    "duffle", "duffel", "duffle bag", "duffel bag", "holdall", "weekender", "weekender bag",
    "travel bag", "gym bag", "sports bag", "kit bag", "luggage", "suitcase", "carry on", "trolley",
    "garment bag", "boston bag",
    "дорожн сумк", "спортивн сумк", "чемодан", "саквояж", "сумк для спортзал",
  ]),
  g("work-bag", "bags", ["Bags"], [
    "briefcase", "laptop bag", "laptop sleeve", "document bag", "portfolio", "work bag", "attache",
    "портфел", "сумк для ноутбук", "папк!",
  ]),
  g("bag", "bags", ["Bags"], [
    "bag", "bags", "purse bag", "sac", "sacoche", "borsa", "bolso", "tasche",
    "сумк", "торб",
  ]),

  // ════════════════════════════════════════════════════════════════════════════
  // ACCESSORIES
  // ════════════════════════════════════════════════════════════════════════════
  g("sunglasses", "accessories", ["Sunglasses"], [
    "sunglasses", "sunglass", "shades", "sunnies", "aviator sunglasses", "aviators", "wayfarer",
    "cat eye sunglasses", "round sunglasses", "shield sunglasses", "wraparound sunglasses",
    "sport sunglasses", "eyewear", "glasses", "optical frames", "spectacles", "glasses frames",
    "lunettes", "lunettes de soleil", "occhiali da sole", "gafas de sol", "sonnenbrille",
    "солнцезащитн очк", "очки!", "окуляр", "сонцезахисн окуляр", "авиатор", "вайфарер",
  ]),
  g("watch", "accessories", ["Watches"], [
    "watch", "wristwatch", "wrist watch", "chronograph", "diver watch", "dive watch", "field watch",
    "dress watch", "automatic watch", "quartz watch", "smartwatch", "smart watch", "timepiece",
    "g shock", "gshock", "casio", "seiko", "swatch", "tank watch", "pilot watch",
    "часы!", "часов!", "наручн час", "годинник", "хронограф",
  ]),
  g("belt", "accessories", ["Belts"], [
    "belt", "leather belt", "web belt", "canvas belt", "reversible belt", "chain belt", "rigger belt",
    "d ring belt", "cobra buckle", "western belt", "braided belt", "logo belt", "suspenders", "braces",
    "ceinture", "cintura", "cinturon", "cinturón", "gürtel",
    "ремень", "ремни", "ремен", "пояс!", "пасок", "ремінь", "підтяжк", "подтяжк",
  ]),
  g("hats", "accessories", ["Hats"], [
    "hat", "hats", "cap", "caps", "baseball cap", "ball cap", "dad hat", "dad cap", "trucker hat",
    "trucker cap", "snapback", "fitted cap", "5 panel", "five panel", "6 panel", "six panel",
    "camp cap", "flat cap", "newsboy cap", "baker boy", "ivy cap", "beanie", "beanies", "watch cap",
    "toque", "bucket hat", "fisherman hat", "boonie", "boonie hat", "sun hat", "straw hat", "fedora",
    "trilby", "panama hat", "panama", "boater", "bowler", "beret", "balaclava", "ski mask", "earflap",
    "trapper hat", "ushanka", "headband", "visor", "sun visor", "cowboy hat", "cloche", "bonnet",
    "durag", "do rag", "headwrap", "kufi", "casquette", "chapeau", "cappello", "gorra", "sombrero",
    "шапк", "шапка-бини", "бини", "бейсболк", "кепк", "кепи", "панам", "берет", "балаклав", "федора",
    "шляп", "капелюх", "картуз", "ушанк", "повязк на голов", "козырёк", "снэпбэк", "тракер",
  ]),
  g("scarf", "accessories", ["Scarves", "Scarf/Shawl", "Scarves & Shawls"], [
    "scarf", "scarves", "muffler", "snood", "neck warmer", "neckerchief", "bandana", "shawl", "stole",
    "wrap scarf", "pashmina", "echarpe", "écharpe", "foulard", "sciarpa", "bufanda",
    "шарф", "платок", "платк", "снуд", "бандан", "палантин", "хустк", "шаль",
  ]),
  g("gloves", "accessories", ["Gloves"], [
    "gloves", "glove", "mittens", "mitten", "fingerless gloves", "driving gloves", "leather gloves",
    "перчатк", "варежк", "рукавиц", "рукавичк", "митенк",
  ]),
  g("socks", "accessories", ["Socks"], [
    "socks", "sock", "crew socks", "ankle socks", "no show socks", "trainer socks", "tube socks",
    "hosiery", "stockings",
    "носк", "носки!", "шкарпетк", "чулк", "гольфы",
  ]),
  g("jewellery", "accessories", ["Jewelry"], [
    "jewellery", "jewelry", "necklace", "chain necklace", "pendant", "bracelet", "bangle", "cuff bracelet",
    "earring", "earrings", "hoops", "hoop earrings", "studs", "ring", "rings", "signet ring", "brooch",
    "pin badge", "anklet", "choker",
    "украшени", "цепочк", "подвеск", "кулон", "браслет", "серьг", "сережк", "кольц", "перстень",
    "брошь", "брошк", "чокер", "прикраси", "намисто",
  ]),
  g("small-leather", "accessories", ["Wallets"], [
    "wallet", "wallets", "cardholder", "card holder", "card case", "billfold", "coin purse", "zip wallet",
    "keyring", "key ring", "keychain", "key fob", "passport holder", "money clip", "lanyard",
    "кошел", "портмоне", "картхолдер", "визитниц", "брелок", "обложк для паспорт", "гаманець",
  ]),
  g("tie", "accessories", ["Ties"], [
    "tie", "necktie", "bow tie", "bowtie", "cravat", "ascot", "pocket square", "cufflinks", "cufflink",
    "tie clip", "tie bar",
    "галстук", "бабочк", "запонк", "платок нагрудн", "краватк",
  ]),
  g("umbrella", "accessories", ["Accessories"], [
    "umbrella", "phone case", "airpods case", "hair clip", "scrunchie", "shoe tree", "shoe horn",
    "shoehorn", "shoe care", "shoe laces", "shoelaces", "shoe box", "shoe rack", "shoe polish",
    "зонт", "парасоль", "чехол для телефон",
  ]),
];

// ── Matching ─────────────────────────────────────────────────────────────────

/** Lowercase, and turn every run of non-letters/digits into one space. */
function normalize(text: string): string {
  return ` ${(text ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

const isCyrillic = (s: string) => /[Ѐ-ӿ]/.test(s);

interface CompiledTerm {
  type: GarmentType;
  /** Order of the type in the list: lower is more specific. */
  rank: number;
  weak: boolean;
  cyrillic: boolean;
  /** Characters of the term, the tie-breaker between terms at one place. */
  length: number;
  re: RegExp;
}

function compileWordTerm(raw: string): { re: RegExp; cyrillic: boolean; length: number } {
  const cyrillic = isCyrillic(raw);
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Split on spaces *before* normalising, so the "!" that marks a word exact
  // survives to be read. Normalising first strips punctuation, "!" with it, and
  // every exact word quietly became a stem — "пилот!" matched "пилотка".
  const words: { text: string; exact: boolean }[] = [];
  for (const token of raw.toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(Boolean)) {
    const exact = token.endsWith("!");
    const parts = (exact ? token.slice(0, -1) : token)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    // "куртка-бомбер" is two words once its hyphen goes; the mark belongs to the last.
    parts.forEach((text, i) => words.push({ text, exact: exact && i === parts.length - 1 }));
  }

  const pattern = words.map(({ text, exact }, i) => {
    const word = escape(text);
    if (cyrillic) {
      // A stem: the word may continue with any ending, unless marked exact.
      return exact ? word : `${word}[\\p{L}]*`;
    }
    // English: whole words, with a plural allowed on the last one.
    return i === words.length - 1 ? `${word}(?:e?s)?` : word;
  });

  return {
    re: new RegExp(` ${pattern.join(" ")}(?= )`, "gu"),
    cyrillic,
    length: words.map((w) => w.text).join(" ").length,
  };
}

const COMPILED: CompiledTerm[] = GARMENT_TYPES.flatMap((type, rank) =>
  type.terms.map((term): CompiledTerm => {
    if (term instanceof RegExp) {
      const flags = term.flags.includes("g") ? term.flags : `${term.flags}g`;
      return { type, rank, weak: false, cyrillic: false, length: term.source.length, re: new RegExp(term.source, flags) };
    }
    const weak = term.startsWith("~");
    const { re, cyrillic, length } = compileWordTerm(weak ? term.slice(1) : term);
    return { type, rank, weak, cyrillic, length, re };
  }),
);

interface Hit {
  term: CompiledTerm;
  start: number;
  end: number;
  text: string;
}

function hitsIn(text: string): Hit[] {
  const hay = normalize(text);
  const hits: Hit[] = [];
  for (const term of COMPILED) {
    term.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = term.re.exec(hay))) {
      hits.push({ term, start: m.index, end: m.index + m[0].length, text: m[0].trim() });
      if (m[0].length === 0) term.re.lastIndex++;
    }
  }
  return hits;
}

export interface GarmentMatch {
  /** The category the title's head noun files it under. */
  category: Category;
  /** The most specific type that agrees with that category. */
  type: GarmentType;
  /** The words in the title that decided it, for "why" messages. */
  matched: string;
  /** Only weak evidence ("knit", "denim"): useful as a fallback, not an override. */
  weak: boolean;
}

/**
 * Types that name a garment only in general. A more specific type of the same
 * category elsewhere in the title names it better: "MA-1 Jacket" is a bomber,
 * "Cargo Trousers" a cargo pant, "Сумка-шоппер" a tote. Any other head keeps
 * its own type, so "Belt Scarf" is a scarf and not the belt the rank order
 * would have picked.
 */
const GENERIC_TYPES = new Set([
  "jacket", "coat", "outerwear", "sweater", "knit", "shirt", "crewneck", "top", "denim",
  "trousers", "boots", "sandals", "sneakers", "shoes", "bag",
]);

/**
 * Where an English title stops describing the piece and starts listing what
 * comes with it: "Skater Jeans/Shorts with “Dagger” Keychain" is shorts, not a
 * keychain, though the keychain is the last noun.
 */
const ATTACHMENT = / (?:with|w|featuring|feat|incl|including|plus) /;

/**
 * What garment a title names, or undefined when it names none this dictionary
 * knows.
 */
export function matchGarment(text: string): GarmentMatch | undefined {
  const all = hitsIn(text);
  if (!all.length) return undefined;

  const strong = all.filter((h) => !h.term.weak);
  const pool = strong.length ? strong : all;

  // The head. A title with Cyrillic garment words is read head-first; any other
  // head-last — up to a "with" clause, when a garment comes before it.
  const cyrillicHits = pool.filter((h) => h.term.cyrillic);
  let latinPool = pool;
  if (!cyrillicHits.length) {
    const cut = normalize(text).search(ATTACHMENT);
    const before = cut >= 0 ? pool.filter((h) => h.end <= cut + 1) : [];
    if (before.length) latinPool = before;
  }
  const head = cyrillicHits.length
    ? cyrillicHits.reduce((a, b) =>
        b.start < a.start || (b.start === a.start && b.term.length > a.term.length) ? b : a)
    : latinPool.reduce((a, b) =>
        b.end > a.end || (b.end === a.end && b.term.length > a.term.length) ? b : a);

  const category = head.term.type.category;

  // The label: the head's own type, or — when the head is a generic word — the
  // most specific type of that category anywhere in the title.
  if (!GENERIC_TYPES.has(head.term.type.id)) {
    return { category, type: head.term.type, matched: head.text, weak: !strong.length };
  }
  const sameCategory = pool.filter((h) => h.term.type.category === category);
  const best = sameCategory.reduce((a, b) =>
    b.term.rank < a.term.rank || (b.term.rank === a.term.rank && b.term.length > a.term.length) ? b : a);

  return { category, type: best.term.type, matched: best.text, weak: !strong.length };
}

/**
 * Do two titles name different garments? Only when both name one and neither is
 * a generic word: "Classic Tee" and "Classic Hoodie" do; "Etnies Shoes Emerson"
 * and "Emerson" do not — "shoes" says footwear, and "Emerson" says nothing.
 */
export function garmentTypesConflict(a: string, b: string): boolean {
  const x = matchGarment(a);
  const y = matchGarment(b);
  if (!x || !y || x.type.id === y.type.id) return false;
  return !GENERIC_TYPES.has(x.type.id) && !GENERIC_TYPES.has(y.type.id);
}

/** The category a title names, from strong evidence only. */
export function garmentCategory(text: string): Category | null {
  const m = matchGarment(text);
  return m && !m.weak ? m.category : null;
}

/** A label reduced to its letters, so "Tank-Tops", "Tank Tops" and "tank tops" compare equal. */
const labelKey = (label: string) => label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The tree label for a title: the first of its type's labels that the tree
 * actually has, spelled the way the tree spells it. `labels` is the tree's
 * label → category map — the live tree's, when the caller has it, because an
 * admin's "Hoodies" and "Long Sleeves" are not in the built-in one.
 */
export function garmentLabel(text: string, labels: Record<string, string>): string | undefined {
  const m = matchGarment(text);
  if (!m) return undefined;
  const byKey = new Map(Object.keys(labels).map((l) => [labelKey(l), l]));
  // Only a label the tree files under the same category: a label that exists
  // but points elsewhere would contradict the category the title just gave.
  for (const wanted of m.type.labels) {
    const label = byKey.get(labelKey(wanted));
    if (label && labels[label] === m.category) return label;
  }
  return undefined;
}

/** How many terms the dictionary holds, per language — for the record. */
export function garmentTermCounts(): { types: number; english: number; cyrillic: number; patterns: number } {
  let english = 0, cyrillic = 0, patterns = 0;
  for (const t of GARMENT_TYPES) {
    for (const term of t.terms) {
      if (term instanceof RegExp) patterns++;
      else if (isCyrillic(term)) cyrillic++;
      else english++;
    }
  }
  return { types: GARMENT_TYPES.length, english, cyrillic, patterns };
}
