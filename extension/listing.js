/**
 * Reading a whole listing: every card a category shows, however it shows them.
 *
 * A store's category page rarely holds its catalogue in the markup it first
 * sends. Some load the next cards as the page is scrolled, some behind a "Show
 * more" button, some over numbered pages, and some take cards away again as
 * they scroll out of sight. Up to 1.0.13 the run read the page as it stood
 * after a second of scrolling, so a category of two hundred jackets gave the
 * first dozen.
 *
 * So the page is walked the way a person walks it: a screen at a time, down to
 * the end, a moment's wait there for the next cards, "Show more" when the store
 * offers one, then the next page. Every link is noted at every step, so a card
 * that has already scrolled away still counts. Nothing here decides which links
 * are products. The planner on the server does that, with the same rules as
 * ever, once the walk is over.
 *
 * The walk happens in the tab the admin is looking at, not in a background
 * copy. Chrome does not load anything for a page nobody can see: in a hidden
 * tab the same 200-card category stopped at its first 24, in a visible one it
 * gave all 200. So the page has to be in front while it is read, and the worker
 * waits, and says so, while it is not.
 */

/**
 * One step of the walk, run in the page.
 *
 * Handed to `chrome.scripting.executeScript` as `func`, so it must stand alone:
 * nothing outside this function exists where it runs. Each call scrolls about a
 * screen and reports the links it has not reported before. The worker calls it
 * again and again, so the walk can be stopped between any two steps and the
 * worker never sits for minutes inside one call. What the page has already
 * reported is remembered on the page itself, and is gone when it navigates,
 * which is when the worker starts counting afresh anyway.
 */
export function listingStep(opts) {
  const o = Object.assign({ first: false, stepMs: 350, settleMs: 2500, clickWaitMs: 4000 }, opts || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = location.hostname.replace(/^www\./, "");
  const st = (globalThis.__gooListing = globalThis.__gooListing || {
    seen: new Set(),
    dead: new WeakSet(),
  });

  /** An address on this store, without its fragment, or "". */
  const resolve = (href) => {
    try {
      const u = new URL(href, document.baseURI);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      if (u.hostname.replace(/^www\./, "") !== host) return "";
      u.hash = "";
      return u.href;
    } catch {
      return "";
    }
  };

  const harvest = () => {
    const out = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const url = resolve(a.getAttribute("href"));
      if (url && !st.seen.has(url)) {
        st.seen.add(url);
        out.push(url);
      }
    }
    return out;
  };

  /**
   * What scrolls. Usually the document; on some stores a full-height panel,
   * and scrolling the window there moves nothing.
   */
  const scroller = () => {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > window.innerHeight + 8) return doc;
    let best = null;
    for (const el of document.querySelectorAll("main, div, section")) {
      if (el.clientHeight < window.innerHeight * 0.5) continue;
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
    return best || doc;
  };

  const box = scroller();
  const height = () => box.scrollHeight;
  const atBottom = () => box.scrollTop + box.clientHeight >= box.scrollHeight - 8;

  const result = {
    ok: true,
    url: location.href,
    visible: document.visibilityState === "visible",
    links: harvest(),
    head: null,
    grew: false,
    clicked: "",
    exhausted: false,
    next: "",
  };

  if (o.first) {
    // What the planner reads besides the links: structured data, which can
    // name the whole category's items or say the page is a single product,
    // and OpenGraph's page type.
    const ld = [];
    let size = 0;
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const text = s.textContent || "";
      if (size + text.length > 1_000_000) break;
      size += text.length;
      ld.push(text);
    }
    const og = document.querySelector('meta[property="og:type"]');
    result.head = { ld, ogType: (og && og.getAttribute("content")) || "" };
  }

  // A page nobody can see loads nothing more, and a product page has no grid
  // to walk: report what is there and let the worker decide.
  if (!result.visible) return result;
  if (o.first && /^(?:og:)?product$/i.test(result.head.ogType)) {
    result.exhausted = true;
    return result;
  }

  const MORE =
    /^(?:load|show|view|see)\s+more\b|^more\s+(?:products|items|results|styles)\b|^(?:показать|загрузить)\s+(?:ещ[её]|больше)|^(?:показати|завантажити)\s+(?:ще|більше)|^mehr\s+(?:anzeigen|laden)|^voir\s+plus|^(?:cargar|mostrar|ver)\s+más|^(?:carica|mostra)\s+altri/i;
  const NEXT =
    /^(?:next(?:\s+page)?|›|»|→|>|далее|вперёд|вперед|следующая(?:\s+страница)?|наступна|далі|weiter|suivant|siguiente|avanti)$/i;
  const PAGE_PARAMS = ["page", "p", "pg", "pagenumber", "pageindex", "page_number"];

  const labelOf = (el) =>
    (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || "")
      .replace(/\s+/g, " ")
      .trim();
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const docTop = (el) => el.getBoundingClientRect().top + window.scrollY;

  /**
   * The store's own "Show more" under the grid, if it has one. Only below the
   * middle of the page and outside the header, menus, footer, side panels and
   * pop-ups: a filter list's "Show more" sits at the top or in a side panel,
   * and opening it adds links that are not cards.
   */
  const moreButton = () => {
    const middle = height() * 0.5;
    let pick = null;
    for (const el of document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')) {
      if (st.dead.has(el) || el.disabled || !shown(el)) continue;
      const label = labelOf(el);
      if (!label || label.length > 60 || !MORE.test(label)) continue;
      if (el.closest('header, nav, footer, aside, dialog, [role="dialog"], [aria-modal="true"], [role="navigation"]')) continue;
      if (docTop(el) < middle) continue;
      if (!pick || docTop(el) > docTop(pick)) pick = el;
    }
    return pick;
  };

  /** The page after this one, when the listing has numbered pages. */
  const nextPage = () => {
    const here = new URL(location.href);
    here.hash = "";
    const fresh = (href) => {
      const url = resolve(href);
      return url && url !== here.href ? url : "";
    };

    for (const el of document.querySelectorAll('link[rel~="next"][href], a[rel~="next"][href]')) {
      const url = fresh(el.getAttribute("href"));
      if (url) return url;
    }

    // `?page=3` → `?page=4`, or `/page/3` → `/page/4`.
    const pageOf = (u) => {
      for (const [k, v] of u.searchParams) {
        if (PAGE_PARAMS.includes(k.toLowerCase()) && /^\d+$/.test(v)) return { n: Number(v), key: k, base: u.pathname };
      }
      const m = u.pathname.match(/^(.*?)\/page\/(\d+)\/?$/i);
      if (m) return { n: Number(m[2]), key: "", base: m[1] || "/" };
      return null;
    };
    const current = pageOf(here);
    const want = (current ? current.n : 1) + 1;
    const base = current ? current.base : here.pathname.replace(/\/$/, "") || "/";
    for (const a of document.querySelectorAll("a[href]")) {
      const url = fresh(a.getAttribute("href"));
      if (!url) continue;
      const p = pageOf(new URL(url));
      if (p && p.n === want && (p.base.replace(/\/$/, "") || "/") === (base.replace(/\/$/, "") || "/")) return url;
    }

    // A link that only says "Next", on this same listing.
    for (const a of document.querySelectorAll("a[href]")) {
      if (!NEXT.test(labelOf(a))) continue;
      const url = fresh(a.getAttribute("href"));
      if (!url) continue;
      const u = new URL(url);
      if (u.pathname === here.pathname || pageOf(u)) return url;
    }
    return "";
  };

  /** Waits for the page to grow: a taller page or links it had not shown. */
  const waitForMore = async (ms) => {
    const h = height();
    const n = st.seen.size;
    for (let t = 0; t < ms; t += 250) {
      await sleep(250);
      result.links.push(...harvest());
      if (location.href !== result.url) return true;
      if (height() > h + 4 || st.seen.size > n) return true;
    }
    return false;
  };

  return (async () => {
    const before = height();
    box.scrollTop = box.scrollTop + Math.max(200, box.clientHeight * 0.85);
    if (box === document.scrollingElement || box === document.documentElement) {
      window.scrollTo(0, box.scrollTop);
    }
    await sleep(o.stepMs);
    result.links.push(...harvest());
    if (!atBottom()) {
      result.grew = true;
      return result;
    }

    // The end of what is loaded. Stores that load on scroll do it now.
    if (height() > before + 4 || (await waitForMore(o.settleMs))) {
      result.grew = true;
      return result;
    }

    const more = moreButton();
    if (more) {
      result.clicked = labelOf(more);
      more.scrollIntoView({ block: "center" });
      await sleep(200);
      more.click();
      if (await waitForMore(o.clickWaitMs)) {
        result.grew = true;
        return result;
      }
      // Clicked and nothing came: not a button worth pressing again.
      st.dead.add(more);
    }

    result.exhausted = true;
    result.next = nextPage();
    return result;
  })();
}

// ── robots.txt ────────────────────────────────────────────────────────────────
//
// The listing's later pages are opened by the extension, not by the admin, so
// robots.txt decides whether they may be. Product pages are checked on the
// server as before; these never reach it. The rules are read exactly as
// src/lib/server/parser/robots.ts reads them (the `*` group, longest match,
// Allow winning a tie), and verification/test-listing.js holds the two to the
// same answers.

function patternToRegex(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") out += ".*";
    else if (ch === "$" && i === pattern.length - 1) out += "$";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}`);
}

function longestMatch(patterns, path) {
  let best = -1;
  for (const p of patterns) {
    if (p.length <= best) continue;
    if (patternToRegex(p).test(path)) best = p.length;
  }
  return best;
}

/** The `*` group of a robots.txt: what it allows, forbids, and how slowly to go. */
export function robotsRules(text) {
  const rules = { allow: [], disallow: [], crawlDelayMs: null };
  if (typeof text !== "string" || !text.trim() || /^\s*</.test(text)) return rules;
  let agents = [];
  let inRules = false;
  let star = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const sep = line.indexOf(":");
    if (!line || sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === "user-agent") {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
      star = agents.includes("*");
      continue;
    }
    if (field !== "allow" && field !== "disallow" && field !== "crawl-delay") continue;
    inRules = true;
    if (!star) continue;
    if (field === "crawl-delay") {
      const secs = Number(value.replace(",", "."));
      if (Number.isFinite(secs) && secs > 0) rules.crawlDelayMs = Math.round(secs * 1000);
      continue;
    }
    if (!value) continue;
    (field === "allow" ? rules.allow : rules.disallow).push(value);
  }
  return rules;
}

/** May the extension open this address? A malformed one may not. */
export function robotsAllows(rules, url) {
  let path;
  try {
    const u = new URL(url);
    path = `${u.pathname}${u.search}` || "/";
  } catch {
    return false;
  }
  const deny = longestMatch(rules.disallow, path);
  if (deny < 0) return true;
  return longestMatch(rules.allow, path) >= deny;
}

// ── What the planner is sent ──────────────────────────────────────────────────

/** An address as a quoted attribute the planner's anchor pattern reads whole. */
function attr(url) {
  return url.replace(/"/g, "%22").replace(/'/g, "%27").replace(/</g, "%3C").replace(/>/g, "%3E");
}

/**
 * The walked listing as a page the planner can read: the structured data and
 * page type of each page walked, then every link in the order it was seen.
 *
 * Sent instead of the page's own markup. After a long walk that markup holds
 * only the cards still on screen, and a category's worth of cards can be past
 * the 3 MB the route accepts. This is what the planner reads of a page
 * (`extractProductLinks`, `pageStatesOneProduct`) and nothing else.
 */
export function planHtml(heads, links) {
  const head = [];
  for (const h of heads) {
    for (const text of h.ld || []) {
      head.push(`<script type="application/ld+json">${String(text).replace(/<\/script/gi, "<\\/script")}</script>`);
    }
    if (h.ogType) head.push(`<meta property="og:type" content="${attr(h.ogType)}">`);
  }
  const body = links.map((u) => `<a href="${attr(u)}"></a>`);
  return `<!doctype html><html><head>${head.join("\n")}</head><body>\n${body.join("\n")}\n</body></html>`;
}
