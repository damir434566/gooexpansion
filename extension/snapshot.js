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

  /** Most breadcrumbs one page can contribute. */
  const MAX_CRUMBS = 12;

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

  /**
   * A price: a currency marker with digits next to it, either order.
   *
   * Case-insensitive, because a Ukrainian store is as likely to print "4 000 ГРН"
   * as "4 000 грн", and a price whose marker is missed here reaches the server as
   * a bare number with no currency at all.
   */
  const PRICE_TEXT =
    /(?:[$€£₴₽¥₺₹₩₪]|zł|Kč|грн|руб|CHF|\b(?:USD|EUR|GBP|UAH|RUB|PLN|CZK|SEK|NOK|DKK|CAD|AUD|JPY|CNY|TRY)\b)\s*[\d][\d\s.,]*|[\d][\d\s.,]*\s*(?:[$€£₴₽¥₺₹₩₪]|zł|Kč|грн|руб|CHF|\b(?:USD|EUR|GBP|UAH|RUB|PLN|CZK|SEK|NOK|DKK|CAD|AUD|JPY|CNY|TRY)\b)/i;

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

  /**
   * Class and id words that mention colour without being the colour control.
   * Shopify themes put `color-scheme-1` on whole page sections, and a section
   * read as "the colour control" made its active navigation link the selected
   * swatch and its product carousel the colour row.
   */
  const NOT_A_COLOR_CONTROL = /scheme|theme|background|^bg|text-colou?r|border-colou?r|accent|palette|mode/i;

  /** A colour control is a row of swatches, not a page: past this many elements it is a section. */
  const MAX_CONTROL_ELEMENTS = 600;

  /** Elements whose own attributes say they are the colour control. */
  function colorContainers() {
    const out = [];
    const all = document.querySelectorAll(
      '[class*="colo" i],[id*="colo" i],[data-testid*="colo" i],[aria-label*="colo" i],[class*="swatch" i],[data-option*="colo" i]',
    );
    for (const el of all) {
      const words = [
        ...(typeof el.className === "string" ? el.className.split(/\s+/) : []),
        el.id || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("data-testid") || "",
        el.getAttribute("data-option") || "",
      ];
      const says = words.some(
        (w) => w && (COLOR_HINT.test(w) || /swatch/i.test(w)) && !NOT_A_COLOR_CONTROL.test(w),
      );
      if (!says) continue;
      if (el.getElementsByTagName("*").length > MAX_CONTROL_ELEMENTS) continue;
      out.push(el);
      if (out.length >= 40) break;
    }
    return out;
  }

  /**
   * A colour name has to be words: not a placeholder, not a number, and not the
   * file name of the swatch's own thumbnail — "A35893_1.jpg" is what a swatch's
   * `alt` holds on plenty of stores, and it used to be sent as the colour. The
   * server applies the same test (`looksLikeColourLabel`); it is repeated here
   * so the next attribute on the swatch gets its turn instead.
   */
  function usableColor(raw) {
    const value = String(raw || "").trim().replace(/\s+/g, " ");
    if (value.length < 2 || value.length > 40) return "";
    if (!/\p{L}/u.test(value)) return "";
    if (/^(?:select|choose|pick|colou?r|цвет|колір)\b/i.test(value)) return "";
    if (/\.(?:jpe?g|png|webp|gif|avif|svg|bmp|tiff?|heic)(?:[?#].*)?$/i.test(value)) return "";
    if (/:\/\/|^\/|^www\./i.test(value)) return "";
    if (value.includes("_") || value.startsWith("#")) return "";
    if (!/\s/.test(value) && /\d.*\d/.test(value)) return "";
    return value;
  }

  /** Text of one short line, or "" for anything longer than a colour's name. */
  function shortText(el) {
    const text = (el && (el.innerText || el.textContent) || "").trim().replace(/\s+/g, " ");
    return text.length >= 2 && text.length <= 40 && !/\n/.test(text) ? text : "";
  }

  /** Option names that mean "colour" in a store's own product data. */
  const COLOR_OPTION = /^(?:colou?rs?|colou?rway|farbe|couleur|colore|kolor|barva|цвет|колір)$/i;

  /** The JSON object starting at `start`, by counting braces outside strings. */
  function balancedObject(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return "";
  }

  /**
   * Shopify's own record of the variant on screen.
   *
   * The selected variant is the form's `id` (or `?variant=` in the address).
   * A theme's product JSON names its options, so the colour option's value is
   * the store stating its colour outright. ShopifyAnalytics' `meta` does not
   * name them — only "grey/white/leather / 7" — so every part of that title is
   * sent, and the server keeps the one that names a colour.
   */
  function shopifyVariantColours() {
    const out = [];
    let wantedId = "";
    try {
      wantedId = new URL(location.href).searchParams.get("variant") || "";
    } catch {
      wantedId = "";
    }
    if (!wantedId) {
      const field = document.querySelector('form[action*="/cart/add"] [name="id"]');
      wantedId = field && field.value ? String(field.value) : "";
    }
    const pickVariant = (variants) =>
      variants.find((v) => v && wantedId && String(v.id) === wantedId) ||
      variants.find((v) => v && v.available) ||
      variants[0];

    const visit = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 5 || out.length >= 4) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (Array.isArray(node.variants) && Array.isArray(node.options)) {
        const names = node.options.map((o) => String((typeof o === "string" ? o : o && o.name) || "").trim());
        const index = names.findIndex((n) => COLOR_OPTION.test(n));
        const variant = pickVariant(node.variants);
        if (index >= 0 && variant) {
          const value = (Array.isArray(variant.options) ? variant.options[index] : undefined) ?? variant[`option${index + 1}`];
          if (value) out.push({ value: String(value), origin: "data" });
        }
        return;
      }
      for (const key of Object.keys(node)) visit(node[key], depth + 1);
    };
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const text = script.textContent || "";
      if (text.length > 2000000 || !text.includes('"variants"')) continue;
      try {
        visit(JSON.parse(text), 0);
      } catch {
        // Not JSON after all; the next block may be.
      }
    }

    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent || "";
      const at = text.indexOf("var meta = {");
      if (at < 0) continue;
      try {
        const meta = JSON.parse(balancedObject(text, at + "var meta = ".length));
        const variants = meta && meta.product && Array.isArray(meta.product.variants) ? meta.product.variants : [];
        const variant = pickVariant(variants);
        for (const part of String((variant && variant.public_title) || "").split(" / ")) {
          out.push({ value: part, origin: "variant" });
        }
      } catch {
        // A theme that writes `meta` differently; nothing to read.
      }
      break;
    }
    return out;
  }

  /** Classes and attributes that mark "the colour you picked", beside the swatch row. */
  const SELECTED_LABEL = [
    '[class*="selected" i][class*="label" i]',
    '[class*="selected" i][class*="value" i]',
    '[class*="selected" i][class*="name" i]',
    '[class*="selected" i][class*="colo" i]',
    '[class*="current" i][class*="colo" i]',
    '[class*="option" i][class*="value" i]',
    '[class*="variant" i][class*="label" i]',
    '[class*="variant" i][class*="name" i]',
    '[class*="swatch" i][class*="label" i]',
    '[class*="swatch" i][class*="name" i]',
    '[class*="swatch" i][class*="title" i]',
    '[class*="colo" i][class*="label" i]',
    '[class*="colo" i][class*="name" i]',
    '[class*="colo" i][class*="title" i]',
    '[class*="colo" i][class*="value" i]',
    "legend",
  ].join(",");

  /**
   * Every string the page offers as the colour it is showing, each with where
   * it was read. The server picks the one that is a colour — see
   * `colour-choice.ts` — because the first that merely looks like words is,
   * on plenty of stores, the product's name in a swatch photo's alt text.
   *
   * In order of how directly the page states it: the store's variant data, the
   * form's checked colour option, the selected swatch's colour attributes, the
   * label beside the swatch row, a "Colour: Charcoal" line; then the weak ones —
   * the swatch photo's alt, and loose text from the colour area.
   */
  function collectColorCandidates() {
    const list = [];
    const seen = new Set();
    const add = (raw, origin) => {
      const value = usableColor(raw);
      if (!value || list.length >= 30) return;
      const key = `${origin}|${value.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ value, origin });
    };

    for (const c of shopifyVariantColours()) add(c.value, c.origin);

    // A form's colour option: `<input type="radio" name="Color" value="Black" checked>`,
    // `<select name="options[Colour]">`, or a fieldset whose legend says colour.
    for (const input of document.querySelectorAll('input[type="radio"]:checked')) {
      const fieldset = input.closest("fieldset");
      const legend = fieldset && fieldset.querySelector("legend");
      if (COLOR_HINT.test(input.name || "") || (legend && COLOR_HINT.test(legend.textContent || ""))) {
        add(input.value, "swatch");
        const label = input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (label) add(shortText(label), "swatch");
      }
    }
    for (const select of document.querySelectorAll("select")) {
      if (!COLOR_HINT.test(`${select.name || ""} ${select.id || ""} ${select.getAttribute("aria-label") || ""}`)) continue;
      const option = select.options && select.options[select.selectedIndex];
      if (option) add(option.textContent, "swatch");
    }

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
        for (const attr of ["aria-label", "title", "data-color", "data-colour", "data-color-name", "data-value"]) {
          add(el.getAttribute(attr), "swatch");
        }
        const img = el.querySelector && el.querySelector("img");
        if (img) {
          add(img.getAttribute("alt"), "alt");
          add(img.getAttribute("title"), "alt");
        }
        add(shortText(el), "text");
        break;
      }
    }

    // The label that repeats the picked colour above or beside the row. It sits
    // next to the swatches rather than inside them, so the row's parent and
    // grandparent are searched too.
    const scopes = new Set();
    for (const container of containers) {
      scopes.add(container);
      if (container.parentElement) scopes.add(container.parentElement);
      if (container.parentElement && container.parentElement.parentElement) {
        scopes.add(container.parentElement.parentElement);
      }
    }
    for (const scope of scopes) {
      if (scope.getElementsByTagName("*").length > MAX_CONTROL_ELEMENTS * 2) continue;
      for (const attr of ["data-selected-value", "data-selected-color", "data-selected-colour", "data-current-value"]) {
        add(scope.getAttribute(attr), "label");
      }
      let labels = [];
      try {
        labels = scope.querySelectorAll(SELECTED_LABEL);
      } catch {
        labels = [];
      }
      for (const el of labels) add(shortText(el), "label");
    }
    for (const attr of ["data-selected-color", "data-selected-colour", "data-color-name"]) {
      const el = document.querySelector(`[${attr}]`);
      if (el) add(el.getAttribute(attr), "label");
    }

    // "Colour: Charcoal" — the label and its value in one line of text.
    for (const container of containers) {
      const text = (container.innerText || container.textContent || "").trim();
      if (!text || text.length > 200) continue;
      const match = text.match(/(?:colou?r|farbe|couleur|colore|цвет|колір)\s*[:：]\s*([^\n,;]{2,40})/i);
      if (match) add(match[1], "line");
    }

    // Loose lines from the colour area: badges ("New", "-20%") and other
    // colourways' names among them. The server takes one of these only when it
    // names a colour and nothing better did.
    for (const scope of scopes) {
      const text = (scope.innerText || "").trim();
      if (!text || text.length > 1500) continue;
      for (const line of text.split(/\n+/)) add(line, "text");
    }

    return list;
  }

  /**
   * One guess, for a server older than 1.0.3 that reads `colorText` only: the
   * first candidate from a place that states colours.
   */
  function colorTextFrom(candidates) {
    const stating = candidates.find((c) => ["data", "swatch", "label", "line"].includes(c.origin));
    return stating ? stating.value : "";
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
   * Every "Label: value" pair in one line of text.
   *
   * A spec block whose rows are bare text nodes renders as ONE line — innerText
   * collapses the newlines — so "Composition: 80% wool Care: dry clean Article:
   * FA-1" arrives as a single string carrying three rows. Reading only the first
   * pair loses the rest; reading them naively makes the first value swallow the
   * second label.
   *
   * So each value ends where the NEXT label begins, and a label is taken as the
   * single word before its colon. One word is deliberate: a label can be two
   * ("Article number"), and there is no way to tell "number" from the tail of the
   * previous value without knowing every label in every language. Cutting one
   * word early would eat a fibre off a composition, which is the failure that
   * matters.
   *
   * The key is then emitted in three forms — the last word, the last two, the
   * last three — because the server matches keys against a vocabulary and
   * "Article number" is in it while "number" is not. Identical values, so a
   * reader takes whichever form it recognises; this is the price of keeping that
   * vocabulary on one side of the wire.
   */
  function pairsFromLine(line) {
    const colons = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ":" || line[i] === "：") colons.push(i);
    }
    if (!colons.length) return [];

    /** The word immediately before `index`, or "" when there is none. */
    const labelBefore = (index) => {
      const match = line.slice(0, index).match(/[\p{L}][\p{L}-]*$/u);
      return match ? match[0] : "";
    };

    const pairs = [];
    for (let i = 0; i < colons.length; i++) {
      const colon = colons[i];
      const label = labelBefore(colon);
      if (!label) continue;

      let end = line.length;
      if (i + 1 < colons.length) {
        const nextLabel = labelBefore(colons[i + 1]);
        if (nextLabel) end = colons[i + 1] - nextLabel.length;
      }

      const value = line.slice(colon + 1, end).trim().replace(/[\s,;.]+$/, "");
      if (!value) continue;

      // Longer key forms, for the vocabularies that spell a label in two words.
      const words = line
        .slice(0, colon)
        .trim()
        .split(/\s+/)
        .filter((w) => /^[\p{L}][\p{L}-]*$/u.test(w));
      const keys = new Set([label]);
      if (words.length >= 2) keys.add(words.slice(-2).join(" "));
      if (words.length >= 3) keys.add(words.slice(-3).join(" "));

      for (const key of keys) pairs.push({ key, value });
    }
    return pairs;
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
        for (const pair of pairsFromLine(line)) add(pair.key, pair.value);
      }
    }

    return out;
  }

  /**
   * The breadcrumb trail, outermost crumb first.
   *
   * This is the store filing the piece for us, and it is the answer to two
   * fields the name cannot always give: a product called "Aurelio" says nothing
   * about being a jacket, and "Women / Clothing / Jackets" says it plainly. A
   * `BreadcrumbList` in JSON-LD survives the strip and the server reads it from
   * the markup; this is for the many stores that render a trail and describe it
   * in no structured form at all.
   *
   * The current page's own crumb — the last one, usually the product name, often
   * not a link — is kept: it costs nothing, and the classifier reads the name
   * first anyway.
   */
  function collectBreadcrumbs() {
    const containers = [
      ...document.querySelectorAll(
        'nav[aria-label*="breadcrumb" i],[class*="breadcrumb" i],[id*="breadcrumb" i],[data-testid*="breadcrumb" i],[itemtype*="BreadcrumbList" i],[class*="крошк" i]',
      ),
    ];

    for (const container of containers) {
      const items = container.querySelectorAll('li,a,[itemprop="name"],span');
      const crumbs = [];
      const seen = new Set();
      for (const item of items) {
        // A <li> wrapping an <a> would otherwise contribute the same crumb twice.
        if (item.querySelector && item.querySelector("a,li,span")) continue;
        const text = squash(textOf(item)).replace(/^[/>·|»–-]\s*|\s*[/>·|»–-]$/g, "");
        if (!text || text.length > 60) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        crumbs.push(text);
        if (crumbs.length >= MAX_CRUMBS) break;
      }
      // One crumb is a link, not a trail — "Home" on its own says nothing.
      if (crumbs.length >= 2) return crumbs;
    }
    return [];
  }

  /**
   * The brand, where the page prints it rather than declares it.
   *
   * Structured data usually carries the brand, which is why it was only
   * sometimes missing; when it is missing it is because the store treats the
   * designer as a link to a designer page instead of as a property of the
   * product. The spec table answers this too, and the server reads it from
   * there — this covers the stores with no table either.
   */
  function collectBrandText() {
    const marked = document.querySelector('[itemprop="brand"]');
    const markedText = squash(textOf(marked));
    if (markedText && markedText.length <= 60) return markedText;

    const candidates = document.querySelectorAll(
      '[class*="brand" i],[class*="designer" i],[data-testid*="brand" i],a[href*="/designer"],a[href*="/brand"]',
    );
    for (const el of candidates) {
      const text = squash(textOf(el));
      // A brand is a name, not a sentence, and not the word "Brand" alone.
      if (!text || text.length < 2 || text.length > 60) continue;
      if (/^(?:brand|designer|бренд|дизайнер)$/i.test(text)) continue;
      return text;
    }
    return "";
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
    const colorCandidates = collectColorCandidates();
    const colorText = colorTextFrom(colorCandidates);
    const variantUrls = collectVariantUrls();
    const descriptionText = collectDescription();
    const specs = collectSpecs();
    const breadcrumbs = collectBreadcrumbs();
    const brandText = collectBrandText();

    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll(DROP).forEach((n) => n.remove());
    // An inline data-URI is a whole image encoded in the attribute. The parser
    // cannot use one and it can be megabytes on its own, so the attribute goes
    // and the element stays.
    root.querySelectorAll('[src^="data:"]').forEach((n) => n.removeAttribute("src"));

    // `innerHTML` drops the root element's own attributes, and `lang` is the one
    // the server reads: when no price on the page names its currency, the
    // store's declared language ("uk-UA") is what tells hryvnia from dollars.
    const lang = (document.documentElement.getAttribute("lang") || "")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 20);

    return {
      ok: true,
      url: location.href,
      html: `<html${lang ? ` lang="${lang}"` : ""}>${root.innerHTML}</html>`,
      images,
      priceText,
      sizes,
      colorText,
      colorCandidates,
      variantUrls,
      descriptionText,
      specs,
      breadcrumbs,
      brandText,
      // The store's own title, for working out the furniture it appends to
      // every page. Sent raw; the server decides what of it is a product name.
      pageTitle: (document.title || "").replace(/\s+/g, " ").trim().slice(0, 200),
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
})();
