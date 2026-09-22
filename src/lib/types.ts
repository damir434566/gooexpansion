export type Gender = "women" | "men" | "unisex";

/**
 * Base color group used in the filter sidebar.
 * Maps specific shades (e.g. "Marsala", "Charcoal") to a parent color family.
 */
export interface ColorGroup {
  id: number;
  name: string;      // "Black", "Red", "Beige" …
  hexCode: string;   // Used for the swatch circle in the filter UI
  sortOrder: number;
}

export type Brand =
  | "Acne Studios"
  | "Balenciaga"
  | "Fear of God"
  | "Toteme"
  | "Lemaire"
  | "The Row"
  | "Jil Sander"
  | "Maison Margiela"
  | "A.P.C."
  | "Cos"
  | "Arket"
  | "Massimo Dutti"
  | "Zara"
  | "& Other Stories"
  | "Nike";

export type Category =
  | "outerwear"
  | "tops"
  | "shirts"
  | "bottoms"
  | "jeans"
  | "shorts"
  | "skirts"
  | "footwear"
  | "accessories"
  | "bags"
  | "dresses"
  | "jumpsuits"
  | "knitwear"
  | "blazers"
  | "swimwear";

export type Occasion =
  | "casual"
  | "work"
  | "evening"
  | "sport"
  | "formal"
  | "weekend";

export type BodyType =
  | "slim"
  | "athletic"
  | "average"
  | "curvy"
  | "petite"
  | "tall";

export type StyleKeyword =
  | "minimal"
  | "streetwear"
  | "classic"
  | "avant-garde"
  | "romantic"
  | "utilitarian"
  | "bohemian"
  | "preppy"
  | "sporty"
  | "dark"
  | "maximalist"
  | "coastal"
  | "academic";

export interface Retailer {
  name: string;
  url: string;
  price: number;
  currency: string;
  availability: "in stock" | "low stock" | "sold out";
  isOfficial: boolean;
  /** Average star rating 1–5 (optional, entered by admin or sourced externally) */
  rating?: number;
  /** Number of reviews backing the rating */
  reviewCount?: number;
}

export interface PricePoint {
  date: string;       // ISO date YYYY-MM-DD
  price: number;
  retailerName?: string;
}

export interface ProductReview {
  id: string;
  productId: string;
  userId: string;
  userName: string;
  rating: number;     // 1–5
  text: string;
  createdAt: string;
}

/**
 * Lightweight swatch used in the catalog card when a product has color variants.
 * Each swatch represents one product linked via variantGroupId.
 */
export interface ProductSwatch {
  id: string;
  name: string;       // product name for this variant
  colorName: string;  // display label (usually colors[0] or product name)
  colorHex: string;   // hex for the circle, e.g. "#1a1a2e"
  priceMin: number;
  priceMax: number;
  imageUrl: string;
  images: string[];
  sizes: string[];
  colorGroupIds?: number[];
  /**
   * The variant's own measured backdrop. A colour variant is a separate row
   * with its own photos, so it can have been shot on a different backdrop than
   * the card's primary product — see `Product.bgColor`.
   */
  bgColor?: string;
}

export interface CropData {
  /** Координаты и размер рамки в долях от оригинала (0–1) */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Точка фокуса внутри рамки (0–1), по умолчанию 0.5 / 0.5 */
  focalX: number;
  focalY: number;
}

export interface Product {
  id: string;
  name: string;
  brand: Brand;
  category: Category;
  /**
   * The filter subcategory this product sits under, e.g. "Sneakers" within
   * `footwear`. Optional: several categories only have one, and rows saved
   * before the field existed do not carry it — see resolveSubcategory().
   */
  subcategory?: string;
  description: string;
  imageUrl: string;
  images: string[];
  colors: string[];
  /** Per-color image arrays. Key = color name, value = image URL list */
  colorImages?: Record<string, string[]>;
  sizes: string[];
  material: string;
  retailers: Retailer[];
  priceMin: number;
  priceMax: number;
  currency: string;
  /**
   * What the store charged, before the importer stated it in dollars.
   *
   * `priceMin`/`priceMax` are the catalogue's own figures and are compared
   * across products, so they are one currency. These three say where a
   * converted figure came from: the amount, its currency, and the rate and day
   * used — enough to re-check a price that looks wrong without re-visiting the
   * store. Absent on products that were priced in dollars to begin with.
   */
  sourcePrice?: number;
  sourceCurrency?: string;
  fxRate?: number;
  fxDate?: string;
  /**
   * The codes that identify this item away from any one store.
   *
   * `gtin` is the item's own number and is verified before it is stored, so two
   * rows carrying the same one are the same thing — which is how a second
   * retailer's page joins this product instead of becoming a second copy of it.
   * `mpn` does the same within a brand. `sku` is one store's shelf label and is
   * kept for reference only.
   */
  gtin?: string;
  mpn?: string;
  sku?: string;
  isNew: boolean;
  isSaved: boolean;
  styleKeywords: StyleKeyword[];
  gender?: Gender;
  /** Links this product to others as color variants of the same model */
  variantGroupId?: string;
  /** HEX color code used for the swatch circle in the catalog (e.g. "#1a1a2e") */
  colorHex?: string;
  /** True = this product is shown as the representative card in the catalog */
  isGroupPrimary?: boolean;
  /** Populated by the API for primary products: swatches of all linked variants */
  variants?: ProductSwatch[];
  /** Manual crop/focal-point data set by admin */
  cropData?: CropData;
  /**
   * IDs of color_groups this product belongs to (supports multi-color items).
   * Stored as int[] on the DB row; used for server- and client-side filtering.
   */
  colorGroupIds?: number[];
  /** ISO date string from DB — used to auto-expire the NEW badge after 7 days */
  createdAt?: string;
  /**
   * `#rrggbb` measured from the four corners of the product photo, used behind
   * the image where `object-contain` leaves padding. Absent when the corners
   * disagreed — a lifestyle shot, a cutout, a photo that bleeds to the edge —
   * in which case the box keeps its own background. See lib/server/bg-color.
   */
  bgColor?: string;
}

export interface OutfitItem {
  product: Product;
  role: "hero" | "secondary" | "accent";
  /** Selected colour key from product.colorImages (if the product has multiple colours) */
  selectedColor?: string;
}

export interface Outfit {
  id: string;
  name: string;
  description: string;
  occasion: Occasion;
  imageUrl: string;
  items: OutfitItem[];
  totalPriceMin: number;
  totalPriceMax: number;
  currency: string;
  styleKeywords: StyleKeyword[];
  isAIGenerated: boolean;
  isSaved: boolean;
  season: "all" | "spring" | "summer" | "autumn" | "winter";
  source?: "community" | null;
  isHomepageFeatured?: boolean;
  /** ISO date string from DB — used for per-entity sitemap lastmod. */
  createdAt?: string;
}

export interface UserProfile {
  bodyType: BodyType;
  styleKeywords: StyleKeyword[];
  preferredColors: string[];
  budget: {
    min: number;
    max: number;
  };
  occasions: Occasion[];
  savedOutfits: string[];
  savedProducts: string[];
  plan: "free" | "basic" | "pro" | "premium";
}

export interface Plan {
  id: "free" | "basic" | "pro" | "premium";
  name: string;
  price: number;
  currency: string;
  billingCycle: "monthly" | "yearly";
  features: string[];
  aiOutfitsPerMonth: number | "unlimited";
  highlighted: boolean;
}

export interface BlogPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  category: string;
  coverImageUrl: string;
  readTime: string;
  authorName: string;
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  isPublished: boolean;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FilterState {
  category?: Category;
  occasion?: Occasion;
  priceMin?: number;
  priceMax?: number;
  brands?: Brand[];
  styleKeywords?: StyleKeyword[];
  sortBy?: "relevance" | "price-asc" | "price-desc" | "newest";
  /** Base color group IDs selected in the color filter */
  colorGroupIds?: number[];
}
