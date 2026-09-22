/**
 * Take the rendered page and hand back what the server needs to read it.
 *
 * Out of here comes the stripped markup, and then what the strip destroys:
 * the photos the page actually shows, the price as a shopper reads it, the
 * sizes it offers, the colour it is showing and the addresses of the same piece
 * in other colours.
 *
 * ── The markup ───────────────────────────────────────────────────────────────
 * This is the bookmarklet in `src/lib/parser-bookmarklet.ts`, with the clicking
 * automated. The strip list is deliberately identical — scripts except JSON-LD,
 * styles, stylesheet links, SVG, noscript, iframes, templates, and inline
 * data-URIs — because the server runs the very same extractor over what comes
 * out of here as over a pasted page.
 *
 * What the strip is for: a retail page is several megabytes, almost all of it
 * script and style the parser never reads, and the route on the other end takes
 * 3 MB. Stripping takes a typical page to a couple of hundred kilobytes.
 *
 * ── Why the extras exist ─────────────────────────────────────────────────────
 * The strip is also lossy in a way that showed up the moment this ran against a
 * single-page storefront. The server's gallery harvester mines inline
 * hydration payloads for image URLs — that is how it finds the photos a React
 * store never writes into its markup — and those payloads are `<script>`, so
 * this file deletes them before the server ever sees them. On a Shopify store
 * the gallery is plain `<img>` and nothing is lost; on Farfetch most of it is
 * in the payload, and the product arrived with the two photos its carousel had
 * mounted.
 *
 * Shipping the payloads back would mean sending the megabytes the strip exists
 * to remove. So the page is read here, where it is still whole, and only the
 * findings travel: image URLs, and the rendered price text. Both are evidence,
 * not answers — the server puts them through the same host-and-naming tests as
 * every other candidate, because a page's script data names the "you may also
 * like" carousel too.
 *
 * This is a deliberate divergence from the bookmarklet, and the only one: the
 * extension can read a page the bookmarklet's one-shot copy cannot.
 *
 * Before reading anything it scrolls the page. That is the whole reason a real
 * tab is worth its cost over a server fetch: a gallery that lazy-loads on
 * scroll is a spinner in the markup until something scrolls past it, and plain
 * `<img src>` afterwards.
 *
 * Injected with `chrome.scripting.executeScript`, so the completion value of
 * the last statement is what the worker receives.
 */

(async () => {
  /** Nodes the parser never reads, and that account for nearly all the weight. */
  const DROP =
    'script:not([type="application/ld+json"]),style,link[rel=stylesheet],svg,noscript,iframe,template';

  /** Most photos one page can contribute. Well past any real gallery. */
  const MAX_IMAGES = 300;

  /** Longest URL kept. Past this it is a data-URI or a tracking pixel's essay. */
  const MAX_URL = 1500;

  /** Script text scanned for image URLs, in total. A ceiling, not a target. */
  const MAX_SCRIPT_SCAN = 8_000_000;

  /** Most size labels one page can contribute. */
  const MAX_SIZES = 80;

  /** Attribute text that marks a corner of the page as being about size. */
  const SIZE_HINT = /size|talla|taille|gr[oö]sse|größe|taglia|розмір|размер/i;

  /** The same, for colour. */
  const COLOR_HINT = /colou?r|farbe|couleur|colore|barva|kolor|cvet|цвет|колір/i;

  /** Most sibling colourway addresses one page can contribute. */
  const MAX_VARIANTS = 20;

  /** Most spec rows one page can contribute. */
  const MAX_SPECS = 40;

  /** Longest description kept. The importer stores five thousand characters. */
  const MAX_DESCRIPTION = 5000;

  /** Shortest run of text that could be a product description rather than a label. */
  const MIN_DESCRIPTION = 80;

  /**
   * Image URLs as they appear in a JSON payload, escaped slashes and all.
   *
   * `\/` is allowed in every segment rather than only after the scheme: a
   * payload that has been JSON-encoded twice escapes every slash in the path,
   * and a pattern that stops at the first backslash matches the scheme and then
   * finds no file extension to confirm. Same pattern as the server's harvester,
   * which unescapes the result the same way.
   */
  const JSON_IMAGE =
    /(?:https?:)?(?:\\?\/){2}(?:[^"'\s\\)>]|\\\/)+?\.(?:jpe?g|png|webp|avif)(?:\?(?:[^"'\s\\)>]|\\\/)*)?/gi;

  /** A price: a currency marker with digits next to it, either order. */
  const PRICE_TEXT =
    /(?:[$€£₴₽¥₺₹₩₪]|zł|Kč|грн|руб|CHF|\b(?:USD|EUR|GBP|UAH|RUB|PLN|CZK|SEK|NOK|DKK|CAD|AUD|JPY|CNY|TRY)\b)\s*[\d][\d\s.,]*|[\d][\d\s.,]*\s*(?:[$€£₴₽¥₺₹₩₪]|zł|Kč|грн|руб|CHF|\b(?:USD|EUR|GBP|UAH|RUB|PLN|CZK|SEK|NOK|DKK|CAD|AUD|JPY|CNY|TRY)\b)/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Resolve against the page, and reject what is not a fetchable address. */
  function absolute(raw) {
    if (!raw) return null;
    const value = String(raw).trim().replace(/\\\//g, "/");
    if (!value || value.length > MAX_URL) return null;
    if (/^data:/i.test(value)) return null;
    try {
      const url = new URL(value, location.href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }

  /**
   * Every address on the page that could be a photo of this product.
   *
   * Deliberately greedy: it costs a few hundred strings, and the server rejects
   * what does not belong to the product. Missing a photo is the expensive
   * mistake, because nothing downstream can recover it without re-visiting the
   * store.
   */
  function collectImages() {
    const found = new Set();
    const add = (raw) => {
      const url = absolute(raw);
      if (url && found.size < MAX_IMAGES) found.add(url);
    };
    const addSrcset = (value) => {
      if (!value) return;
      for (const part of String(value).split(",")) {
        add(part.trim().split(/\s+/)[0]);
      }
    };

    // `currentSrc` first: on a responsive image it is the rendition the browser
    // actually chose and loaded, which no attribute in the markup states.
    for (const img of document.images) {
      add(img.currentSrc);
      add(img.getAttribute("src"));
      addSrcset(img.getAttribute("srcset"));
      addSrcset(img.getAttribute("data-srcset"));
      for (const attr of [
        "data-src", "data-original", "data-lazy", "data-image",
        "data-zoom-image", "data-large_image", "data-large", "data-full", "data-hires",
      ]) {
        add(img.getAttribute(attr));
      }
    }

    for (const source of document.querySelectorAll("picture source")) {
      addSrcset(source.getAttribute("srcset"));
      addSrcset(source.getAttribute("data-srcset"));
    }

    for (const link of document.querySelectorAll('link[as="image"]')) {
      add(link.getAttribute("href"));
      addSrcset(link.getAttribute("imagesrcset"));
    }

    // The payloads this file is about to delete. A virtualised carousel keeps
    // the slides it has not mounted here and nowhere else.
    let scanned = 0;
    for (const script of document.querySelectorAll("script")) {
      if (found.size >= MAX_IMAGES || scanned >= MAX_SCRIPT_SCAN) break;
      const text = script.textContent;
      if (!text || text.length < 24) continue;
      scanned += text.length;
      const matches = text.match(JSON_IMAGE);
      if (!matches) continue;
      for (const match of matches) {
        if (found.size >= MAX_IMAGES) break;
        add(match);
      }
    }

    return [...found];
  }

  /**
   * The sizes the page offers, as a shopper sees them.
   *
   * This is the field the parser had no source for at all: its JSON-LD reader
   * returned an empty list by design, so unless an admin had written a per-site
   * recipe rule, a product arrived with no sizes. And sizes are a control, not
   * text — buttons, a select, a swatch row — so the strip removes every trace
   * of them along with the styles that made them look like buttons.
   *
   * Read loosely on purpose. The corner of a page that mentions "size" also
   * holds "Select size", a size-guide link and sometimes a quantity stepper;
   * `pickSizes` on the server decides which of these strings is a size, so the
   * vocabulary lives in one place instead of being spelled out here too.
   *
   * Sold-out sizes are collected like the rest. The catalogue records the sizes
   * a piece comes in, not today's stock in one store, and it has nowhere to put
   * the difference — a size dropped here would read as a size that does not
   * exist.
   */
  function collectSizes() {
    const found = [];
    const seen = new Set();
    const add = (raw) => {
      const value = String(raw || "").trim().replace(/\s+/g, " ");
      if (!value || value.length > 24) return;
      const key = value.toLowerCase();
      if (seen.has(key) || found.length >= MAX_SIZES) return;
      seen.add(key);
      found.push(value);
    };

    /** Does this element say, in any of its attributes, that it is about size? */
    const hinted = (el) => {
      const attrs = [
        typeof el.className === "string" ? el.className : "",
        el.id || "",
        el.getAttribute("name") || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("data-testid") || "",
        el.getAttribute("data-option") || "",
      ].join(" ");
      return SIZE_HINT.test(attrs);
    };

    // A select is the least ambiguous of the three: its options are the sizes,
    // in the store's own order, minus the placeholder that carries no value.
    for (const select of document.querySelectorAll("select")) {
      if (!hinted(select)) continue;
      for (const option of select.options) {
        if (!option.value && option.disabled) continue;
        add(option.getAttribute("data-value") || option.textContent);
      }
    }

    // A store that labels its swatches states the size in the attribute, which
    // beats reading the button's text — the text is sometimes just a number in
    // a sprite.
    for (const el of document.querySelectorAll("[data-size],[data-option-size],[data-value-size]")) {
      add(
        el.getAttribute("data-size") ||
          el.getAttribute("data-option-size") ||
          el.getAttribute("data-value-size"),
      );
    }

    // And the common case: clickable things inside a container that says size.
    const containers = document.querySelectorAll(
      '[class*="size" i],[id*="size" i],[data-testid*="size" i],[aria-label*="size" i],fieldset,[role="radiogroup"]',
    );
    for (const container of containers) {
      if (found.length >= MAX_SIZES) break;
      if (!hinted(container)) continue;
      const items = container.querySelectorAll(
        'button,label,li,a,span[role="button"],input[type="radio"]',
      );
      for (const item of items) {
        if (found.length >= MAX_SIZES) break;
        if (item.tagName === "INPUT") add(item.value || item.getAttribute("aria-label"));
        else add(item.innerText || item.textContent);
      }
    }

    return found;
  }

  /** Elements whose own attributes say they are the colour control. */
  function colorContainers() {
    const out = [];
    const all = document.querySelectorAll(
      '[class*="colo" i],[id*="colo" i],[data-testid*="colo" i],[aria-label*="colo" i],[class*="swatch" i],[data-option*="colo" i]',
    );
    for (const el of all) {
      const attrs = [
        typeof el.className === "string" ? el.className : "",
        el.id || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("data-testid") || "",
        el.getAttribute("data-option") || "",
      ].join(" ");
      if (COLOR_HINT.test(attrs) || /swatch/i.test(attrs)) out.push(el);
      if (out.length >= 40) break;
    }
    return out;
  }

  /** A colour name has to be a word, not a placeholder or a number. */
  function usableColor(raw) {
    const value = String(raw || "").trim().replace(/\s+/g, " ");
    if (value.length < 2 || value.length > 40) return "";
    if (/^\d+$/.test(value)) return "";
    if (/^(?:select|choose|pick|colou?r|цвет|колір)\b/i.test(value)) return "";
    return value;
  }

  /**
   * The colour this page is showing, in the store's own word for it.
   *
   * The catalogue builds the swatch, the colour filter and a good part of the
   * stylist's vocabulary out of this one string, and a store almost never puts
   * it in structured data. It puts it in the swatch the shopper has selected —
   * an aria-label, a title, a tiny image's alt text — or in a line that reads
   * "Colour: Charcoal". All three are asked, in that order: a selected swatch
   * is the page pointing at its own answer.
   */
  function collectColorText() {
    const containers = colorContainers();
    const selected = [
      '[aria-checked="true"]',
      '[aria-selected="true"]',
      '[aria-pressed="true"]',
      '[data-selected="true"]',
      ".selected",
      ".active",
      ".is-selected",
      ".is-active",
    ];

    for (const container of containers) {
      for (const selector of selected) {
        let el = null;
        try {
          el = container.matches(selector) ? container : container.querySelector(selector);
        } catch {
          el = null;
        }
        if (!el) continue;
        const img = el.querySelector && el.querySelector("img");
        const name = usableColor(
          el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.getAttribute("data-color") ||
            el.getAttribute("data-colour") ||
            el.getAttribute("data-color-name") ||
            (img && img.getAttribute("alt")) ||
            el.innerText ||
            el.textContent,
        );
        if (name) return name;
      }
    }

    for (const attr of ["data-selected-color", "data-selected-colour", "data-color-name"]) {
      const el = document.querySelector(`[${attr}]`);
      const name = el && usableColor(el.getAttribute(attr));
      if (name) return name;
    }

    // "Colour: Charcoal" — the label and its value in one line of text.
    for (const container of containers) {
      const text = (container.innerText || container.textContent || "").trim();
      if (!text || text.length > 200) continue;
      const match = text.match(
        /(?:colou?r|farbe|couleur|colore|цвет|колір)\s*[:：]\s*([^\n,;]{2,40})/i,
      );
      const name = match && usableColor(match[1]);
      if (name) return name;
    }

    return "";
  }

  /**
   * The same piece in other colours, as the colour row links it.
   *
   * This is the catalogue's variant grouping stated by the page itself, and it
   * is worth far more than guessing from names: an address either matches a row
   * we already have or it does not. Junk that happens to live in the colour row
   * — a size-guide link, a care-instructions anchor — is left in: the server
   * drops it with the same test the collect planner uses to recognise a product
   * address, so this side does not need a second opinion about what a product
   * URL looks like.
   */
  function collectVariantUrls() {
    const out = new Set();
    const here = location.href.split("#")[0];
    for (const container of colorContainers()) {
      if (out.size >= MAX_VARIANTS) break;
      for (const anchor of container.querySelectorAll("a[href]")) {
        if (out.size >= MAX_VARIANTS) break;
        const url = absolute(anchor.getAttribute("href"));
        if (!url) continue;
        const clean = url.split("#")[0];
        if (clean === here) continue;
        try {
          if (new URL(clean).origin !== location.origin) continue;
        } catch {
          continue;
        }
        out.add(clean);
      }
    }
    return [...out];
  }

  /**
   * An element's text, whether or not it is on screen.
   *
   * `innerText` is what a reader sees, which is the right answer for a price and
   * the wrong one for a collapsed accordion: a store that hides its description
   * behind "Details ⌄" has the text in the DOM and `innerText` returns nothing
   * for it. `textContent` does not care about rendering, so it is the fallback —
   * and only the fallback, because it also returns the text of things a reader
   * would never see.
   */
  function textOf(el) {
    if (!el) return "";
    const rendered = (el.innerText || "").trim();
    return rendered || (el.textContent || "").trim();
  }

  const squash = (value) => String(value || "").replace(/\s+/g, " ").trim();

  /**
   * The product's description, as the page renders it.
   *
   * Two rules, both learned from the shape of a retail page. `itemprop` wins
   * outright — a store that marks its description has told us which block it is.
   * Otherwise the SHORTEST candidate over the length of a label wins, not the
   * longest: these containers nest, and the outer one holds the description plus
   * delivery, returns and the reviews teaser. The innermost block that is long
   * enough to be prose is the description itself.
   */
  function collectDescription() {
    const marked = document.querySelector('[itemprop="description"]');
    const markedText = squash(textOf(marked));
    if (markedText.length >= MIN_DESCRIPTION) return markedText.slice(0, MAX_DESCRIPTION);

    const candidates = document.querySelectorAll(
      '[class*="descri" i],[id*="descri" i],[data-testid*="descri" i],[class*="product-details" i],[class*="product-info" i],[class*="опис" i]',
    );
    let best = "";
    for (const el of candidates) {
      const text = squash(textOf(el));
      if (text.length < MIN_DESCRIPTION) continue;
      if (!best || text.length < best.length) best = text;
    }
    if (best) return best.slice(0, MAX_DESCRIPTION);

    // Nothing prose-length: take the longest short thing rather than nothing, so
    // a one-line product blurb still arrives.
    for (const el of candidates) {
      const text = squash(textOf(el));
      if (text.length > best.length) best = text;
    }
    return best.slice(0, MAX_DESCRIPTION);
  }

  /**
   * A value that has swallowed the next row, cut back to itself.
   *
   * A spec block whose rows are bare text nodes renders as ONE line — innerText
   * collapses the newlines — so "Composition: 80% wool Care: dry clean" arrives
   * as a single pair whose value runs into the next label. The cut is made at
   * the LAST word before that label's colon, and one word is deliberate: a label
   * can be two words ("Made in:"), and there is no way to tell "Made" from a
   * fibre without knowing every label in every language. One word always cuts in
   * the right place or one word late, where two words can cut a fibre off a
   * composition — which is the failure that matters, since the composition is
   * what the material field is read from.
   *
   * Rows that come from a definition list or a table need none of this; this is
   * the fallback for stores that use neither.
   */
  function cutAtNextLabel(value) {
    const colon = value.search(/[:：]/);
    if (colon < 0) return value;
    const before = value.slice(0, colon);
    const label = before.match(/[\p{L}][\p{L}-]*$/u);
    if (!label) return value;
    const cut = before.length - label[0].length;
    return cut > 0 ? value.slice(0, cut).replace(/[\s,;.]+$/, "") : value;
  }

  /**
   * The store's spec table, row by row, in the store's own words.
   *
   * Composition, care, country of origin, article number: printed as a
   * definition list, a two-column table, or plain "Label: value" lines, and
   * carried by structured data almost never. The rows are sent as they were
   * printed — the server knows which key means composition in six languages, and
   * it also needs the ones it does not recognise yet.
   */
  function collectSpecs() {
    const out = [];
    const seen = new Set();
    const add = (rawKey, rawValue) => {
      const key = squash(rawKey).replace(/[:：]\s*$/, "");
      const value = squash(rawValue);
      if (!key || !value || key.length > 40 || value.length > 200) return;
      if (key.toLowerCase() === value.toLowerCase()) return;
      const dedupe = `${key.toLowerCase()}=${value.toLowerCase()}`;
      if (seen.has(dedupe) || out.length >= MAX_SPECS) return;
      seen.add(dedupe);
      out.push({ key, value });
    };

    for (const dl of document.querySelectorAll("dl")) {
      const kids = [...dl.children];
      for (let i = 0; i < kids.length - 1; i++) {
        if (kids[i].tagName === "DT" && kids[i + 1].tagName === "DD") {
          add(textOf(kids[i]), textOf(kids[i + 1]));
        }
      }
    }

    for (const tr of document.querySelectorAll("tr")) {
      const cells = tr.querySelectorAll("th,td");
      if (cells.length === 2) add(textOf(cells[0]), textOf(cells[1]));
    }

    // "Composition: 80% wool" as a line of text, which is how a store that uses
    // neither a list nor a table writes it.
    const blocks = document.querySelectorAll(
      '[class*="spec" i],[class*="detail" i],[class*="composition" i],[class*="material" i],[class*="attribute" i],[class*="характеристик" i],[class*="склад" i]',
    );
    for (const block of blocks) {
      if (out.length >= MAX_SPECS) break;
      const text = textOf(block);
      if (!text || text.length > 2000) continue;
      for (const line of text.split(/\n+/)) {
        const match = line.match(/^\s*([^:：]{2,40})[:：]\s*(.{1,200})$/);
        if (!match) continue;
        add(match[1], cutAtNextLabel(match[2]));
      }
    }

    return out;
  }

  /**
   * The price as the page states it, symbol included.
   *
   * The symbol is the point. A store that writes `<span>4 000 ₴</span>` and a
   * bare number in its structured data leaves the server with no way to know
   * what currency it is looking at, and a price taken for dollars because
   * nobody said otherwise is how a coat ends up in the catalogue at forty times
   * its price. Elements that name themselves "price" are asked first; the
   * body's own text is the fallback, and its first match is the one the layout
   * puts nearest the top, which on a product page is the product's price.
   */
  function collectPriceText() {
    const named = document.querySelectorAll(
      '[itemprop="price"],[data-price],[class*="price" i],[id*="price" i],[data-testid*="price" i]',
    );
    for (const el of named) {
      // Skip the containers that merely wrap a price block: their text carries
      // the delivery estimate and the instalment offer along with it.
      const text = (el.innerText || el.textContent || "").trim();
      if (!text || text.length > 40) continue;
      if (!el.offsetParent && el.tagName !== "META") continue;
      const match = text.match(PRICE_TEXT);
      if (match) return match[0].trim().slice(0, 120);
    }

    const body = (document.body && document.body.innerText) || "";
    const match = body.match(PRICE_TEXT);
    return match ? match[0].trim().slice(0, 120) : "";
  }

  try {
    // Walk the page so lazy images commit to a real `src`. Four steps is enough
    // for the galleries this is aimed at without turning a snapshot into a
    // visible scroll animation the admin has to wait through.
    const height = document.body ? document.body.scrollHeight : 0;
    if (height > window.innerHeight) {
      for (let i = 1; i <= 4; i++) {
        window.scrollTo(0, (height / 4) * i);
        await sleep(220);
      }
      window.scrollTo(0, 0);
      await sleep(150);
    }

    // Read before stripping: all of these live in what the strip removes.
    const images = collectImages();
    const priceText = collectPriceText();
    const sizes = collectSizes();
    const colorText = collectColorText();
    const variantUrls = collectVariantUrls();
    const descriptionText = collectDescription();
    const specs = collectSpecs();

    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll(DROP).forEach((n) => n.remove());
    // An inline data-URI is a whole image encoded in the attribute. The parser
    // cannot use one and it can be megabytes on its own, so the attribute goes
    // and the element stays.
    root.querySelectorAll('[src^="data:"]').forEach((n) => n.removeAttribute("src"));

    return {
      ok: true,
      url: location.href,
      html: `<html>${root.innerHTML}</html>`,
      images,
      priceText,
      sizes,
      colorText,
      variantUrls,
      descriptionText,
      specs,
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
})();
