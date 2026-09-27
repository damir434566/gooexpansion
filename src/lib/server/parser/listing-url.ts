/**
 * One store's page, whichever way its address is spelled.
 *
 * A card and its store links are keyed by address, and addresses were compared
 * as strings. So the same page collected as `…/am90` and again as
 * `www.…/am90/?srsltid=…` — the tracking tag Google adds to every result, a
 * trailing slash, `www.` — was two pages: the second never found the card the
 * first made, and a second card appeared beside it.
 *
 * And a store was known by its name. Two sites that resolve to one name
 * (`nike.com` and `nike.ua` are both "Nike") were one store, so adding the
 * second replaced the first's link on the card. A store is its host.
 */

/** Query parameters that say who sent the visitor, never which page it is. */
const TRACKING =
  /^(?:utm_[a-z_]+|srsltid|gclid|gclsrc|gbraid|wbraid|dclid|fbclid|yclid|msclkid|ttclid|twclid|igshid|mc_cid|mc_eid|_ga|_gl|_hsenc|_hsmi|ref|ref_src|referrer|_pos|_sid|_ss|_psq|_fid|_v|pr_prod_strat|pr_rec_id|pr_rec_pid|pr_ref_pid|pr_seq|spm|scm|cmpid|irclickid|irgwc|clickid|click_id|affiliate_id|aff_id)$/i;

/** The store a link belongs to: its host, lower case, without `www.`. */
export function storeHost(url: string | null | undefined): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./i, "").replace(/\.$/, "").toLowerCase() : "";
  } catch {
    return "";
  }
}

/** Do two links belong to one store? False when either has no host. */
export function sameStore(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = storeHost(a);
  return !!x && x === storeHost(b);
}

/**
 * A page's address with the spelling taken out: host as `storeHost`, no
 * trailing slash, no tracking parameters, the rest sorted. A Shopify product
 * reached through a collection (`/collections/men/products/x`) is the product
 * (`/products/x`). Scheme and fragment are not part of which page it is.
 */
export function listingKey(url: string | null | undefined): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    let path = u.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
    path = path.replace(/^\/collections\/[^/]+(\/products\/[^/]+)$/i, "$1");
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING.test(k))
      .sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
    return `${storeHost(raw)}${path}${query}`;
  } catch {
    return raw;
  }
}

/** Are two links one page? */
export function sameListing(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = listingKey(a);
  return !!x && x === listingKey(b);
}

/**
 * The spellings a stored `source_url` may have for this page, for an exact
 * database lookup: as given, and its clean form with and without `www.`, a
 * trailing slash and `https`. At most nine.
 */
export function urlSpellings(url: string | null | undefined): string[] {
  const raw = (url ?? "").trim();
  if (!raw) return [];
  const out = new Set<string>([raw]);
  try {
    const u = new URL(raw);
    const key = listingKey(raw);
    const host = storeHost(raw);
    const rest = key.slice(host.length);
    const [path, query = ""] = rest.split(/(?=\?)/);
    const q = query ?? "";
    for (const scheme of ["https", u.protocol.replace(/:$/, "")]) {
      for (const h of [host, `www.${host}`]) {
        for (const p of path === "/" ? ["/"] : [path, `${path}/`]) out.add(`${scheme}://${h}${p}${q}`);
      }
    }
  } catch {
    /* not an address — only the raw string */
  }
  return [...out].slice(0, 9);
}
