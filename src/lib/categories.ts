/**
 * The catalog's two-level category tree, shared by the browse filters, the
 * outfit builder, the admin product editor and the breadcrumbs on a product
 * page.
 *
 * A product stores two values. `category` is the fixed bucket the rest of the
 * code filters and classifies on; several labels can share one — Sneakers,
 * Sandals and Boots are all `footwear`. `subcategory` is the label naming
 * which of them a piece actually is, and it only resolves when the tree still
 * claims that label for that category.
 *
 * The tree itself lives in the database (`category_groups` /
 * `category_subcategories`, migration 011) and is edited in the admin panel
 * under Categories. Everything below is the built-in default: the tree as it
 * was hardcoded. It is what renders when the migration has not run, when the
 * database is unreachable, and on the client's first paint before
 * `/api/categories` answers — so the functions here take the live tree as an
 * argument and fall back to the default when given none.
 */
import type { Category } from "@/lib/types";

export type SizeType = "letter" | "number" | "eu" | "one-size";

export interface CategoryItem {
  label: string;
  value: string;
  /**
   * The `category_subcategories` row this came from. Present only on a tree
   * loaded from the database — the admin editor needs it to address a row,
   * and its absence is what marks the built-in default as read-only.
   */
  id?: number;
  /**
   * The sizes this kind of thing comes in. A subcategory knows this and a
   * category does not — Belts and Watches are both `accessories`, and only one
   * of them has sizes. Absent means "fall back to the category's chart".
   */
  sizeType?: SizeType;
  sizes?: string[];
}

export interface CategoryGroup {
  id: string;
  label: string;
  items: CategoryItem[];
}

/**
 * The category values the code itself knows about.
 *
 * These are the buckets the importer's keyword classifier can assign, the
 * outfit builder slots pieces into, and the size presets and "wear it with"
 * hints are keyed by. The list has to stay in step with the `Category` union
 * in types.ts — the `satisfies` clause makes a drift there a compile error
 * here.
 *
 * The admin panel can point a subcategory at a bucket outside this list; see
 * `bucketsInTree`. Such a bucket works everywhere the catalog reads the tree,
 * and is simply unknown to the features above.
 */
export const CATEGORY_VALUES = [
  "outerwear", "tops", "shirts", "knitwear", "blazers",
  "bottoms", "jeans", "shorts", "skirts",
  "dresses", "jumpsuits",
  "footwear", "bags", "accessories", "swimwear",
] as const satisfies readonly Category[];

export function isBuiltInBucket(value: string): boolean {
  return (CATEGORY_VALUES as readonly string[]).includes(value);
}

/**
 * Every bucket the tree currently points at, built-in or not.
 *
 * A custom bucket has no table of its own: it exists exactly as long as a
 * subcategory names it, so re-pointing or deleting the last one that uses it
 * retires it with no leftovers to clean up.
 */
export function bucketsInTree(tree: CategoryGroup[]): string[] {
  const seen = new Set<string>();
  for (const group of tree) for (const item of group.items) seen.add(item.value);
  return [...seen].sort();
}

/** Buckets and group ids both end up in URLs, so hold them to a plain slug. */
export function normalizeSlug(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isValidSlug(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value) && value.length >= 2 && value.length <= 32;
}

export const DEFAULT_CATEGORY_GROUPS: CategoryGroup[] = [
  {
    id: "outerwear",
    label: "Outerwear",
    items: [
      { label: "Jackets", value: "outerwear" },
      { label: "Coats", value: "outerwear" },
      { label: "Parkas", value: "outerwear" },
      { label: "Vests", value: "outerwear" },
      { label: "Bomber Jackets", value: "outerwear" },
      { label: "Raincoats", value: "outerwear" },
      { label: "Blazers", value: "blazers" },
    ],
  },
  {
    id: "tops",
    label: "Tops",
    items: [
      { label: "T-Shirts", value: "tops" },
      { label: "Hoodies & Sweatshirts", value: "tops" },
      { label: "Shirts", value: "shirts" },
      { label: "Knitwear", value: "knitwear" },
    ],
  },
  {
    id: "bottoms",
    label: "Bottoms",
    items: [
      { label: "Pants", value: "bottoms" },
      { label: "Jeans", value: "jeans" },
      { label: "Shorts", value: "shorts" },
      { label: "Skirts", value: "skirts" },
    ],
  },
  {
    id: "dresses",
    label: "Dresses",
    items: [
      { label: "Dresses", value: "dresses" },
      { label: "Jumpsuits", value: "jumpsuits" },
    ],
  },
  {
    id: "footwear",
    label: "Footwear",
    items: [
      { label: "Sneakers", value: "footwear" },
      { label: "Sandals", value: "footwear" },
      { label: "Boots", value: "footwear" },
    ],
  },
  {
    id: "accessories",
    label: "Accessories",
    items: [
      { label: "Bags", value: "bags" },
      { label: "Hats", value: "accessories" },
      { label: "Belts", value: "accessories" },
      { label: "Sunglasses", value: "accessories" },
      { label: "Watches", value: "accessories" },
    ],
  },
];

/**
 * Every form a word might be the plural of, itself included.
 *
 * A set rather than one answer, because English plurals in -ies are ambiguous
 * and the tree contains both kinds: "accessories" is the plural of "accessory",
 * "hoodies" of "hoodie", and no rule tells them apart without a dictionary. Both
 * candidates are generated and a match on either counts — cheaper and more
 * honest than a stemmer that is right most of the time.
 *
 * What it must never do is mangle a word that merely ends in s: "dress" is not
 * the plural of "dres".
 */
function wordForms(word: string): string[] {
  const forms = new Set<string>([word]);
  if (word.length > 3) {
    if (word.endsWith("ies")) {
      forms.add(`${word.slice(0, -3)}y`);
      forms.add(word.slice(0, -1));
    } else if (/(?:s|x|z|ch|sh)es$/.test(word)) {
      forms.add(word.slice(0, -2));
    } else if (!word.endsWith("ss") && word.endsWith("s")) {
      forms.add(word.slice(0, -1));
    }
  }
  return [...forms];
}

/**
 * The tree's own label for what a piece of text is describing.
 *
 * The importer had no answer for subcategory at all — it wrote none, so every
 * product landed with the field empty and the filter showed it under whatever
 * its category implied. The label is in the text: a product called "Wool-blend
 * bomber jacket" is a Bomber Jacket, and a breadcrumb reading "Women / Clothing
 * / Jackets" says Jackets.
 *
 * Matching is by words, not by substring, and the most specific label wins — a
 * bomber jacket matches both "Jackets" and "Bomber Jackets", and the second is
 * the answer. Labels that name two things ("Hoodies & Sweatshirts") match on
 * either half, and a trailing plural is stripped from every word so "Sneakers"
 * finds a sneaker.
 *
 * Returns undefined when nothing in the tree is named, which is the honest
 * answer for "Silk scarf" in a tree with no scarf label — the caller then falls
 * back to what the category implies.
 */
export function matchSubcategoryLabel(
  text: string,
  tree: CategoryGroup[] = DEFAULT_CATEGORY_GROUPS,
): string | undefined {
  const words = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(" ")
      .filter(Boolean);

  // Both sides are expanded, not just the label: a page writes "Jackets" where
  // the tree writes "Jackets" and the product name writes "jacket", and all
  // three have to meet.
  const textWords = words(text ?? "");
  if (textWords.join(" ").length < 3) return undefined;
  const haystack = new Set(textWords.flatMap(wordForms));

  const hasWord = (word: string) => wordForms(word).some((form) => haystack.has(form));

  let best: { label: string; score: number } | undefined;

  for (const group of tree) {
    for (const item of group.items) {
      // "Hoodies & Sweatshirts" is two names for one label.
      for (const half of item.label.split(/\s*&\s*/)) {
        const parts = words(half);
        if (!parts.length) continue;
        if (!parts.every(hasWord)) continue;
        if (!best || parts.length > best.score) best = { label: item.label, score: parts.length };
      }
    }
  }

  return best?.label;
}

/** Subcategory label → the category value it filters on. */
export function subcategoryToValue(
  tree: CategoryGroup[] = DEFAULT_CATEGORY_GROUPS,
): Record<string, string> {
  return Object.fromEntries(tree.flatMap((g) => g.items.map((i) => [i.label, i.value])));
}

/** The group a stored category value belongs to. */
export function groupForCategory(
  category: string,
  tree: CategoryGroup[] = DEFAULT_CATEGORY_GROUPS,
): CategoryGroup | undefined {
  return tree.find((g) => g.items.some((i) => i.value === category));
}

/**
 * The group a product belongs to.
 *
 * Prefer its subcategory label, and only fall back to the category value. Two
 * groups may point at the same value — a "Sport" group whose Leggings are
 * stored as `bottoms` sits alongside the Bottoms group — and the value alone
 * cannot tell them apart, so resolving by it would always name whichever group
 * comes first and strand the other. Labels are unique across the whole tree
 * (the `category_subcategories` table enforces it), so one names its group
 * exactly.
 *
 * A piece with no subcategory yet genuinely could be in either, so the value's
 * first group is the right answer there.
 */
export function groupForProduct(
  category: string,
  subcategory: string | undefined,
  tree: CategoryGroup[] = DEFAULT_CATEGORY_GROUPS,
): CategoryGroup | undefined {
  if (subcategory) {
    const owner = tree.find((g) => g.items.some((i) => i.label === subcategory));
    if (owner) return owner;
  }
  return groupForCategory(category, tree);
}

/** Every subcategory label a stored category value can carry. */
export function subcategoriesForCategory(
  category: string,
  tree: CategoryGroup[] = DEFAULT_CATEGORY_GROUPS,
): string[] {
  return tree
    .flatMap((g) => g.items)
    .filter((i) => i.value === category)
    .map((i) => i.label);
}

/**
 * The subcategory label implied by a stored value, when only one claims it.
 *
 * `blazers` is only ever "Blazers", so it resolves. `footwear` is claimed by
 * Sneakers, Sandals and Boots alike, so the category alone cannot say which —
 * that is what a product's own `subcategory` records. This stays as the
 * fallback for rows saved before the field existed.
 */
export function subcategoryForCategory(
  category: string,
  tree: CategoryGroup[] = DEFAULT_CATEGORY_GROUPS,
): string | undefined {
  const labels = subcategoriesForCategory(category, tree);
  return labels.length === 1 ? labels[0] : undefined;
}

/**
 * The subcategory to show for a product: its own if the tree still claims it
 * for that category, otherwise the one its category implies. Returns undefined
 * when neither can name it.
 */
export function resolveSubcategory(
  category: string,
  subcategory?: string,
  tree: CategoryGroup[] = DEFAULT_CATEGORY_GROUPS,
): string | undefined {
  if (subcategory && subcategoriesForCategory(category, tree).includes(subcategory)) {
    return subcategory;
  }
  return subcategoryForCategory(category, tree);
}
