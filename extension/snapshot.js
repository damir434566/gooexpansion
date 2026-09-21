/**
 * Take the rendered page and hand back markup small enough to post.
 *
 * This is the bookmarklet in `src/lib/parser-bookmarklet.ts`, with the clicking
 * automated. The strip list is deliberately identical — scripts except JSON-LD,
 * styles, stylesheet links, SVG, noscript, iframes, templates, and inline
 * data-URIs — because the server runs the very same extractor over what comes
 * out of here as over a pasted page. Diverging here would mean a product
 * imported by the extension could differ from the same product pasted by hand,
 * and there would be no way to tell which was right.
 *
 * What the strip is for: a retail page is several megabytes, almost all of it
 * script and style the parser never reads, and the route on the other end takes
 * 3 MB. Stripping takes a typical page to a couple of hundred kilobytes.
 *
 * Why JSON-LD survives: it is the densest source of truth on a retail page —
 * name, brand, every image, price, currency, colour and material as data rather
 * than as markup to mine.
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll(DROP).forEach((n) => n.remove());
    // An inline data-URI is a whole image encoded in the attribute. The parser
    // cannot use one and it can be megabytes on its own, so the attribute goes
    // and the element stays.
    root.querySelectorAll('[src^="data:"]').forEach((n) => n.removeAttribute("src"));

    return { ok: true, url: location.href, html: `<html>${root.innerHTML}</html>` };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
})();
