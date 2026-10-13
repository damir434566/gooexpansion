/**
 * The whole store: every category its menu offers, then its sitemaps.
 *
 * "Collect this page" walks one listing. A store of six hundred thousand
 * pieces is hundreds of listings, and the admin asked for all of them without
 * opening each by hand. So the run reads the store's own menu for its
 * categories, walks each one the way "Collect this page" walks a listing
 * (listing.js), and opens every piece it finds once, however many categories
 * show it: "New in", "Jackets" and "Sale" share most of their cards. Last come
 * the store's sitemaps, for the pieces no menu category led to.
 *
 * A run like that takes days, so it is written down as it goes: which
 * categories there are, which one it is on and on which page, and every piece
 * already opened. Stop, a store that refuses twice, Chrome restarting: Resume
 * carries on from there and opens nothing twice.
 *
 * Nothing here decides what a product is. The planner on the server still
 * does, from the links each walk hands it. This module decides what is worth
 * walking: the store's own categories, in the language the admin is browsing
 * in, and not its cart, its help pages or its blog.
 */

// ── Reading the menu (runs in the page) ──────────────────────────────────────

/**
 * Every link on the store's page, with where it sits: in the menu, in the
 * footer, or in the page itself.
 *
 * Handed to `chrome.scripting.executeScript` as `func`, so it stands alone.
 * Mega-menus keep their links in the page while they are closed, hidden but
 * present, so they are read with `textContent` rather than `innerText`, which
 * is empty for anything not on screen.
 */
export function menuStep() {
  const host = location.hostname.replace(/^www\./, "");
  const NAV =
    'header, nav, [role="navigation"], [role="menubar"], [role="menu"], [role="banner"]';
  const FOOT = 'footer, [role="contentinfo"]';
  // Class names and ids that mark a menu on stores without the landmarks:
  // `site-header__nav`, `mega-menu`, `MenuDrawer`, `category-list`.
  const NAVISH = /(?:^|[\s_-])(?:menu|menus|nav|navbar|navigation|megamenu|mega|drawer|header|catalog|categories|category-list)(?:$|[\s_-]|[A-Z])/i;

  const where = (a) => {
    if (a.closest(FOOT)) return "footer";
    if (a.closest(NAV)) return "menu";
    for (let el = a.parentElement; el && el !== document.body; el = el.parentElement) {
      const name = `${typeof el.className === "string" ? el.className : ""} ${el.id || ""}`;
      if (NAVISH.test(name)) return "menu";
    }
    return "page";
  };

  const out = [];
  const roots = [document];
  for (let i = 0; i < roots.length && i < 2000 && out.length < 5000; i++) {
    for (const a of roots[i].querySelectorAll("a[href]")) {
      let url;
      try {
        const u = new URL(a.getAttribute("href"), document.baseURI);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        if (u.hostname.replace(/^www\./, "") !== host) continue;
        u.hash = "";
        url = u.href;
      } catch {
        continue;
      }
      const label = (a.getAttribute("aria-label") || a.textContent || a.getAttribute("title") || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      out.push({ url, label, where: where(a) });
      if (out.length >= 5000) break;
    }
    for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  return { ok: true, url: location.href, links: out };
}

// ── Which links are categories ───────────────────────────────────────────────

/** Categories one run walks, at most. */
export const MAX_CATEGORIES = 1_500;

/**
 * Menu links a store needs before its menu is trusted on its own. Fewer, and
 * the links in the page itself are read too: a store whose menu is drawn only
 * when it is opened still shows its categories as tiles on the home page.
 */
const MIN_MENU = 3;

/**
 * Path segments that are never a category: the store's furniture rather than
 * its shelves. The server's `NON_PRODUCT_SEGMENTS` (extract.ts) and then some,
 * because here the question is whether a page lists pieces at all.
 */
const NOT_A_CATEGORY = new Set([
  "cart", "bag", "basket", "checkout", "login", "logout", "signin", "sign-in", "signout", "sign-out",
  "signup", "sign-up", "register", "registration", "account", "my-account", "myaccount", "profile",
  "auth", "wishlist", "favourites", "favorites", "saved", "help", "faq", "faqs", "support",
  "customer-service", "customer-care", "customerservice", "contact", "contact-us", "contacts",
  "about", "about-us", "our-story", "company", "careers", "career", "jobs", "press", "privacy",
  "privacy-policy", "terms", "terms-and-conditions", "terms-of-service", "terms-of-use", "legal",
  "imprint", "impressum", "cookie", "cookies", "cookie-policy", "returns", "return", "refund",
  "refunds", "shipping", "delivery", "payment", "payments", "size-guide", "sizing", "size-chart",
  "store-locator", "storelocator", "stores", "store-finder", "find-a-store", "gift-card",
  "gift-cards", "giftcard", "giftcards", "blog", "blogs", "news", "magazine", "editorial", "journal",
  "stories", "story", "search", "sitemap", "newsletter", "subscribe", "feedback", "reviews",
  "track-order", "order-tracking", "orders", "order-status", "sustainability", "investors",
  "investor-relations", "affiliates", "affiliate", "app", "apps", "download", "accessibility",
  "policies", "policy", "pages", "community", "events", "membership", "loyalty", "rewards",
]);

/** Query parameters that say who sent the visitor, never which page it is. */
const TRACKING =
  /^(?:utm_[a-z_]+|srsltid|gclid|gclsrc|gbraid|wbraid|dclid|fbclid|yclid|msclkid|ttclid|igshid|mc_cid|mc_eid|_ga|_gl|ref|ref_src|referrer|spm|scm|cmpid|icid|intcmp|cm_sp|cm_re)$/i;

/** Query parameters that switch the store to another country or language. */
const LOCALE_PARAM = /^(?:lang|language|locale|country|currency|region|hl|shipto|ship_to|site)$/i;

/** Query parameters that only sort or filter a category: the category is the address without them. */
const VIEW_PARAM =
  /^(?:sort|sortby|sort_by|order|orderby|order_by|dir|view|page|pg|p|limit|per_page|perpage|show|size|sizes|color|colour|colors|colours|price|min_price|max_price|instock|in_stock|available|filter(?:\..*|\[.*\])?|f)$/i;

/** A file that is not a page: `look-book.pdf`, `logo.png`, `feed.xml`. */
const NOT_A_PAGE = /\.(?!(?:html?|aspx?|php|jsp|cfm)$)[a-z0-9]{2,5}$/i;

/** A path segment naming a country or a language: `en`, `en-us`, `ua`, `en_GB`. */
const LOCALE = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;

/**
 * The language part of an address: `/en-us`, `/ua/en`, or "".
 *
 * A store's menu, and its sitemaps more so, link the same catalogue in every
 * language it speaks. Walked as they come, the run would collect each piece
 * once per language. So the run keeps to the language of the page the admin
 * started on.
 */
export function localePrefix(pathname) {
  const out = [];
  // At most two: a country and a language (`/ua/en`), in either order.
  for (const s of String(pathname || "").split("/").filter(Boolean).slice(0, 2)) {
    if (!LOCALE.test(s)) break;
    out.push(s.toLowerCase());
  }
  return out.length ? `/${out.join("/")}` : "";
}

/** Is this address in the same language as the start page? */
export function sameLocale(url, prefix) {
  try {
    return localePrefix(new URL(url).pathname) === prefix;
  } catch {
    return false;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** An address without its query and fragment: how the planner names a page. */
export function pagePath(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

/**
 * One link as a category address, or "" when it is not one.
 *
 * Tracking tags and sort or filter parameters are taken off, so "Jackets" and
 * "Jackets, newest first" are one category. A link that switches country or
 * language, leads to the cart, an account page, help, the blog, or a file, is
 * not a category at all.
 */
export function categoryAddress(href, startUrl) {
  let u;
  let start;
  try {
    start = new URL(startUrl);
    u = new URL(href, start);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (hostOf(u.href) !== hostOf(start.href)) return "";
  u.hash = "";

  const segs = u.pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());
  if (!segs.length && !u.search) return ""; // the home page
  if (segs.some((s) => NOT_A_CATEGORY.has(s))) return "";
  if (segs.length && NOT_A_PAGE.test(segs[segs.length - 1])) return "";
  if (localePrefix(u.pathname) !== localePrefix(start.pathname)) return "";

  const kept = [];
  for (const [k, v] of u.searchParams) {
    if (LOCALE_PARAM.test(k)) return "";
    if (TRACKING.test(k) || VIEW_PARAM.test(k)) continue;
    kept.push([k, v]);
  }
  u.search = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
  if (!segs.length && !u.search) return "";
  return u.href;
}

/**
 * The categories worth walking, in the order the store's menu lists them.
 *
 * `links` is what `menuStep` read. The menu and the footer are the store's own
 * list of its shelves; the page itself is read too only when the menu offers
 * fewer than `MIN_MENU`. Each category once, by its address without a trailing
 * slash. The start page is not among them: the run walks it first anyway.
 */
export function categoryCandidates(links, startUrl, max = MAX_CATEGORIES) {
  const list = Array.isArray(links) ? links : [];
  const startKey = keyOf(categoryAddress(startUrl, startUrl) || startUrl.split("#")[0]);

  const pick = (pool) => {
    const out = [];
    const keys = new Set([startKey]);
    for (const link of pool) {
      if (!link || typeof link.url !== "string") continue;
      const url = categoryAddress(link.url, startUrl);
      if (!url) continue;
      const key = keyOf(url);
      if (keys.has(key)) continue;
      keys.add(key);
      out.push({ url, label: cleanLabel(link.label) || labelFromPath(url), where: link.where || "page" });
      if (out.length >= max) break;
    }
    return out;
  };

  const menu = pick(list.filter((l) => l && (l.where === "menu" || l.where === "footer")));
  if (menu.length >= MIN_MENU) return menu;
  return pick(list);
}

function keyOf(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`.toLowerCase();
  } catch {
    return url;
  }
}

function cleanLabel(label) {
  return typeof label === "string" ? label.replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

/** "Men · Jackets" out of `/men/jackets`, for a link that says nothing itself. */
export function labelFromPath(url) {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const prefix = localePrefix(new URL(url).pathname).split("/").filter(Boolean).length;
    const words = segs
      .slice(prefix)
      .map((s) => decodeURIComponent(s).replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ").trim())
      // `/c/…`, `/p/…`: a store's own shorthand, not a name.
      .filter((w) => w.length > 2);
    return words.slice(-2).join(" · ").slice(0, 60) || "/";
  } catch {
    return "";
  }
}

// ── What one plan call is handed ─────────────────────────────────────────────

/**
 * Links handed to the planner in one call. It answers with at most 2,000
 * products (`planCollection`'s cap), and products are a part of the links it
 * is sent, so a chunk this size can never lose one to the cap. A walk of a
 * category bigger than that is planned in several calls.
 */
export const PLAN_LINKS = 1_500;

/**
 * Addresses in one piece of a sitemap, in the sweep. The pieces of a run that
 * wants a few hundred pieces are cut by bytes alone (sitemap-pieces.js), up to
 * twenty thousand addresses a piece, of which the planner returns its 2,000.
 * The whole store needs every one, so the sweep cuts by count too.
 */
export const SWEEP_ENTRIES = 1_500;

// ── Sitemaps, all of them ────────────────────────────────────────────────────

/**
 * The child sitemaps of an index worth reading, products first.
 *
 * The planner reads ten children out of an index (`MAX_CHILDREN_PER_INDEX` in
 * plan-collection.ts): enough for a run that wants a few hundred pieces, not
 * for a store with sixty product sitemaps. So for the whole store the index
 * is read here, with the same ranking as `rankChild` in sitemap.ts (and
 * verification/test-site.js holds the two to the same answers): sitemaps
 * named after products first, never the blog's, pages', collections' or
 * marketing ones. Only the store's own host.
 */
export function sitemapChildren(xml, host) {
  const want = String(host || "").replace(/^www\./, "").toLowerCase();
  const out = [];
  const seen = new Set();
  for (const m of String(xml || "").matchAll(/<loc>\s*(?:<!\[CDATA\[\s*)?([^<\s\]]+)/gi)) {
    const url = m[1].replace(/&amp;/g, "&");
    if (seen.has(url) || hostOf(url) !== want) continue;
    seen.add(url);
    out.push({ url, rank: rankChild(url), at: out.length });
  }
  return out
    .filter((c) => c.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((c) => c.url);
}

/** `rankChild` in sitemap.ts, word for word. */
export function rankChild(url) {
  const u = String(url).toLowerCase();
  if (/product/.test(u)) return 0;
  if (/(?:blog|article|page|collection|marketing)/.test(u)) return 2;
  return 1;
}

export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(String(xml || ""));
}

// ── What has been opened already ─────────────────────────────────────────────

const DB_NAME = "goo-collect";
const SEEN = "seen";

/**
 * Every piece a whole-store run has opened, so no piece is opened twice: not
 * in the next category that shows it, not in the sitemaps, not after Resume.
 *
 * Kept in IndexedDB, which a six-hundred-thousand-address list fits in and
 * `chrome.storage` does not. Where IndexedDB cannot be opened the list lives
 * in memory: the run still opens nothing twice, it only forgets on a restart.
 */
export class SeenStore {
  constructor() {
    this.db = null;
    this.memory = null;
  }

  async open() {
    if (this.db || this.memory) return;
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(SEEN)) req.result.createObjectStore(SEEN);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("blocked"));
      });
      this.db.onclose = () => {
        this.db = null;
      };
    } catch {
      this.db = null;
      this.memory = new Set();
    }
  }

  /**
   * One transaction: `work` queues its requests on the store and returns a
   * promise of what they come to, which is answered once the transaction
   * has completed, so a write is on disk before the run moves on.
   */
  tx(mode, work) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(SEEN, mode);
      const value = Promise.resolve(work(t.objectStore(SEEN)));
      t.oncomplete = () => value.then(resolve, reject);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("aborted"));
    });
  }

  async clear() {
    await this.open();
    if (this.memory) return this.memory.clear();
    await this.tx("readwrite", (store) => void store.clear());
  }

  async add(url) {
    await this.open();
    if (this.memory) return void this.memory.add(url);
    await this.tx("readwrite", (store) => void store.put(1, url));
  }

  /** The addresses not opened yet, each once, in the order given. */
  async fresh(urls) {
    await this.open();
    const list = [...new Set((urls || []).filter((u) => typeof u === "string" && u))];
    if (this.memory) return list.filter((u) => !this.memory.has(u));
    const asked = (store, u) =>
      new Promise((resolve) => {
        const req = store.count(u);
        req.onsuccess = () => resolve(req.result ? "" : u);
        req.onerror = () => resolve(u);
      });
    const out = await this.tx("readonly", (store) => Promise.all(list.map((u) => asked(store, u))));
    return out.filter(Boolean);
  }

  async count() {
    await this.open();
    if (this.memory) return this.memory.size;
    return this.tx(
      "readonly",
      (store) =>
        new Promise((resolve) => {
          const req = store.count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(0);
        }),
    );
  }
}
