/**
 * Take the rendered page and hand back what the server needs to read it.
 *
 * Four things come out of here: the stripped markup, the photos the page
 * actually shows, the price as a shopper reads it, and the sizes it offers.
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
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
})();
