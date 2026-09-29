/**
 * Pages the collect extension sends that are not the product it was sent for.
 *
 * The extension opens a product's address and sends whatever the tab shows.
 * Two things can stand in the product's place, and both were imported as a
 * piece — with the name "Access Denied" or "Women's Dresses" and the photos of
 * a logo or a whole shelf:
 *
 *   - a bot check. Akamai, Cloudflare, PerimeterX, DataDome and Imperva answer
 *     a browser they are unsure of with a page of their own, often with status
 *     200, so the extension's refusal count never saw it;
 *   - a redirect. A sold-out or removed piece sends the tab to its category,
 *     and the category's markup arrived under the piece's address.
 *
 * Pure: the collect route asks before it parses anything, and says why.
 */
import { looksLikeProductPath } from "./extract";
import { sameListing } from "./listing-url";

/** Titles a bot check gives its page, as each vendor ships it. */
const CHECK_TITLE =
  /^\s*(?:access denied|just a moment\.*|attention required!?(?:\s*\|\s*cloudflare)?|pardon our interruption|are you a (?:robot|human)\??|robot or human\??|please verify you are (?:a )?human|verify you are human|human verification|security check|checking your browser.*|one more step|access to this page has been denied\.?|request unsuccessful\..*|you have been blocked|error 1020|403 forbidden|forbidden|too many requests)\s*$/i;

/**
 * What a bot check says or carries in its body. Matched only on a page that
 * does not also describe a product — a real product page can have a reCAPTCHA
 * in its newsletter form.
 */
const CHECK_BODY =
  /press\s*(?:&amp;|&)\s*hold|confirm you are a human|verify (?:that )?you are (?:a )?human|checking (?:if the site connection is secure|your browser before accessing)|enable javascript and cookies to continue|you don't have permission to access|captcha-delivery\.com|px-captcha|_incapsula_resource|incapsula incident|cf-browser-verification|cf-challenge|challenge-platform|this request was blocked by (?:our|the) security service|please enable js and disable any ad blocker/i;

/** Does the markup describe a product of its own? */
function describesProduct(html: string): boolean {
  return (
    /<meta[^>]+property=["']og:type["'][^>]+content=["']product/i.test(html) ||
    /"@type"\s*:\s*"(?:Product|ProductGroup)"/i.test(html) ||
    /itemtype=["']https?:\/\/schema\.org\/Product["']/i.test(html)
  );
}

function titleOf(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

/** The bot check a page is, by its title or its body, or "" when it is not one. */
export function botCheckIn(html: string): string {
  const title = titleOf(html);
  if (title && CHECK_TITLE.test(title)) return title;
  if (describesProduct(html)) return "";
  const body = html.match(CHECK_BODY);
  return body ? body[0] : "";
}

/**
 * Why this page must not be imported as the product at `url`, or null when it
 * may be. `finalUrl` is where the tab ended up (extension 1.0.12 and later);
 * without it only the markup is judged.
 */
export function notAProductPage(input: { url: string; finalUrl?: string; html: string }): string | null {
  const check = botCheckIn(input.html);
  if (check) {
    return `the store showed a bot check instead of the page ("${check.slice(0, 60)}") — open the store in a normal tab, pass the check, then collect again`;
  }

  const final = (input.finalUrl ?? "").trim();
  if (final && !sameListing(final, input.url)) {
    let path = "";
    try {
      path = new URL(final).pathname;
    } catch {
      return null;
    }
    if (!looksLikeProductPath(path)) {
      return `the store sent this address to ${path}, which is not a product page — sold out or removed`;
    }
  }
  return null;
}
