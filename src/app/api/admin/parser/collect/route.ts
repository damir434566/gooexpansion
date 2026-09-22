/**
 * Catalogue collection driven from the admin's own browser.
 *
 * The sibling of `crawl/route.ts`, for the stores that route cannot reach. The
 * difference is where the fetching happens: `crawl` asks the store from our
 * server and is refused by anyone with anti-bot in front of them, while this
 * route never touches the store at all. A Chrome extension opens each page in a
 * real tab on the admin's machine — their address, their cookies, the challenge
 * their browser already passed — and hands back the rendered DOM.
 *
 * So the server keeps the judgement and gives up the reach:
 *
 *   plan   — page + sitemaps + robots.txt in, product addresses and a pace out
 *   ingest — one page's markup in, one product in the catalogue out
 *
 * `ingest` is the bookmarklet's route with the clicking automated. It passes
 * `html` to `parsePage`, which skips the fetch and the storefront probe
 * entirely, so nothing is asked of the store from here — and then runs the same
 * extractor, gallery harvester and import as every other path into the
 * catalogue. There is no second code path for extension-collected products.
 *
 * The extension cannot call this route itself: our session is a Clerk cookie
 * that will not travel cross-origin, and an API token shipped inside an
 * extension is a key under the doormat. It talks to the collect screen instead,
 * which calls this with the admin's ordinary session.
 */
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/server/admin-auth";
import { logAdminAction } from "@/lib/server/audit";
import { clerkClient } from "@clerk/nextjs/server";
import { parsePage } from "@/lib/server/parser/parse-page";
import { importParsedProduct } from "@/lib/server/parser/import-product";
import { planCollection, type FetchedSitemap } from "@/lib/server/parser/plan-collection";
import {
  getFetchSettings,
  getFetchApiKey,
  getSiteConfigs,
  getAiSettings,
} from "@/lib/server/parser/configs";
import type { CrawlItemResult } from "@/lib/server/parser/types";

export const maxDuration = 60;

/**
 * Largest page we accept, matching `parse/route.ts`.
 *
 * The content script strips what the bookmarklet strips before sending, so a
 * page arriving over this means the strip did not run — worth saying plainly
 * rather than letting the platform refuse the body with an opaque error.
 */
const MAX_PAGE_HTML = 3_000_000;

/** Largest sitemap document we will read in one `plan` call. */
const MAX_SITEMAP_XML = 5_000_000;

/** Sitemap documents accepted per `plan` call. */
const MAX_SITEMAPS = 12;

/** Addresses the caller may say it has already seen, for de-duplication. */
const MAX_SEEN = 5_000;

/**
 * Image candidates one page may offer.
 *
 * The extension reads the rendered page and its hydration payloads before
 * stripping them (see `extension/snapshot.js`), so these are addresses the
 * markup below no longer contains. Generous, because the gallery harvester
 * rejects what does not belong to the product and a photo missed here cannot be
 * recovered without visiting the store again — and bounded, because this is a
 * list a browser extension puts in a request body.
 */
const MAX_IMAGE_CANDIDATES = 300;

/** Longest image address accepted. Past this it is not an address. */
const MAX_IMAGE_URL = 1_500;

/** Longest rendered price string accepted, e.g. "4 000 ₴". */
const MAX_PRICE_TEXT = 120;

/**
 * Size labels one page may offer.
 *
 * Sixty is past any real size run — a shoe store ships twenty, a jeans store
 * with waist-by-length pairs maybe forty — and the list is filtered by
 * `pickSizes` before anything is stored, so a generous ceiling costs nothing
 * but a few strings.
 */
const MAX_SIZE_CANDIDATES = 60;

/** Longest size label accepted. "One size" is nine characters. */
const MAX_SIZE_LABEL = 24;

/** Longest colour name accepted, e.g. "Charcoal marl". */
const MAX_COLOR_TEXT = 80;

/**
 * Sibling colourway addresses one page may name.
 *
 * Each is looked up against `source_url` exactly, so a junk link that happened
 * to sit in the colour row matches nothing and costs nothing.
 */
const MAX_VARIANT_URLS = 20;

/** Longest rendered description accepted; the importer stores 5,000 characters. */
const MAX_DESCRIPTION = 5_000;

/** Breadcrumbs accepted, and the length of one crumb. */
const MAX_BREADCRUMBS = 12;
const MAX_CRUMB = 60;

/** Longest brand name accepted. */
const MAX_BRAND_TEXT = 80;

/** Spec rows accepted, and the size of one row's halves. */
const MAX_SPECS = 40;
const MAX_SPEC_KEY = 40;
const MAX_SPEC_VALUE = 200;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const action = body?.action === "ingest" ? "ingest" : "plan";

  // ── plan ───────────────────────────────────────────────────────────────────
  // Pure: nothing here reaches the network. Everything it reasons about was
  // fetched by the browser and posted here.
  if (action === "plan") {
    const url = str(body?.url);
    if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

    const html = typeof body?.html === "string" ? body.html : "";
    if (html.length > MAX_PAGE_HTML) {
      return NextResponse.json({ error: "Page markup is over the 3 MB limit" }, { status: 413 });
    }

    const sitemaps: FetchedSitemap[] = (Array.isArray(body?.sitemaps) ? body.sitemaps : [])
      .filter(
        (s: unknown): s is FetchedSitemap =>
          !!s &&
          typeof s === "object" &&
          typeof (s as FetchedSitemap).url === "string" &&
          typeof (s as FetchedSitemap).xml === "string" &&
          (s as FetchedSitemap).xml.length <= MAX_SITEMAP_XML,
      )
      .slice(0, MAX_SITEMAPS);

    const seen = (Array.isArray(body?.seen) ? body.seen : [])
      .filter((u: unknown): u is string => typeof u === "string")
      .slice(0, MAX_SEEN);

    const plan = planCollection({
      startUrl: url,
      html: html || undefined,
      robotsTxt: typeof body?.robotsTxt === "string" ? body.robotsTxt : undefined,
      sitemaps,
      seen,
      limit: Number(body?.limit) || 60,
    });

    return NextResponse.json({ ok: true, ...plan });
  }

  // ── ingest ─────────────────────────────────────────────────────────────────
  const url = str(body?.url);
  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

  const html = typeof body?.html === "string" ? body.html : "";
  if (!html.trim()) {
    // Without markup this route would fall through to a server fetch — the very
    // request the extension exists to avoid. Refuse instead of quietly doing it.
    return NextResponse.json({ error: "html is required for ingest" }, { status: 400 });
  }
  if (html.length > MAX_PAGE_HTML) {
    return NextResponse.json(
      {
        error: `Page is ${Math.round(html.length / 1_000_000)} MB, over the ${MAX_PAGE_HTML / 1_000_000} MB limit. The content script should have stripped scripts and styles before sending.`,
      },
      { status: 413 },
    );
  }

  // What the page showed that its stripped markup no longer says. Both are
  // candidates at the lowest precedence: every structured source wins over
  // them, and the image list still has to pass the gallery harvester's
  // host-and-naming tests.
  const imageCandidates = (Array.isArray(body?.images) ? body.images : [])
    .filter(
      (u: unknown): u is string =>
        typeof u === "string" && u.length <= MAX_IMAGE_URL && /^https?:\/\//.test(u),
    )
    .slice(0, MAX_IMAGE_CANDIDATES);
  const priceText = str(body?.priceText).slice(0, MAX_PRICE_TEXT);
  const sizeCandidates = (Array.isArray(body?.sizes) ? body.sizes : [])
    .filter((v: unknown): v is string => typeof v === "string" && v.length <= MAX_SIZE_LABEL)
    .slice(0, MAX_SIZE_CANDIDATES);
  const colorText = str(body?.colorText).slice(0, MAX_COLOR_TEXT);
  const variantUrls = (Array.isArray(body?.variantUrls) ? body.variantUrls : [])
    .filter(
      (u: unknown): u is string =>
        typeof u === "string" && u.length <= MAX_IMAGE_URL && /^https?:\/\//.test(u),
    )
    .slice(0, MAX_VARIANT_URLS);
  const descriptionText = str(body?.descriptionText).slice(0, MAX_DESCRIPTION);
  const specs = (Array.isArray(body?.specs) ? body.specs : [])
    .map((row: unknown) => ({
      key: str((row as { key?: unknown })?.key).slice(0, MAX_SPEC_KEY),
      value: str((row as { value?: unknown })?.value).slice(0, MAX_SPEC_VALUE),
    }))
    .filter((row: { key: string; value: string }) => !!row.key && !!row.value)
    .slice(0, MAX_SPECS);
  const breadcrumbs = (Array.isArray(body?.breadcrumbs) ? body.breadcrumbs : [])
    .map((v: unknown) => str(v).slice(0, MAX_CRUMB))
    .filter(Boolean)
    .slice(0, MAX_BREADCRUMBS);
  const brandText = str(body?.brandText).slice(0, MAX_BRAND_TEXT);

  const [fetchSettings, keyInfo, siteConfigs, aiSettings] = await Promise.all([
    getFetchSettings(),
    getFetchApiKey(),
    getSiteConfigs(),
    getAiSettings(),
  ]);

  const useAi = typeof body?.useAi === "boolean" ? body.useAi : aiSettings.enabled;
  const mirrorImages =
    typeof body?.mirrorImages === "boolean" ? body.mirrorImages : aiSettings.downloadImages;
  const dryRun = body?.dryRun === true;

  let result: CrawlItemResult;

  try {
    const parsed = await parsePage(url, {
      fetchSettings,
      fetchApiKey: keyInfo.key,
      siteConfigs,
      aiSettings,
      useAi,
      html,
      evidence: {
        images: imageCandidates,
        priceText,
        sizes: sizeCandidates,
        colorText,
        variantUrls,
        descriptionText,
        specs,
        breadcrumbs,
        brandText,
      },
    });

    const usedAi = (parsed.diagnostics.aiFields?.length ?? 0) > 0;
    const product = parsed.products[0];

    if (!parsed.ok) {
      result = { url, status: "failed", reason: parsed.error ?? "Could not read the page", usedAi };
    } else if (!product || !product.name) {
      result = {
        url,
        status: "skipped",
        reason: parsed.diagnostics.aiError ?? "No product data on the page",
        usedAi,
      };
    } else if (dryRun) {
      result = { url, status: "skipped", reason: "Dry run", name: product.name, usedAi };
    } else {
      const imported = await importParsedProduct(
        product as unknown as Record<string, unknown>,
        product.sourceUrl || url,
        { mirrorImages },
      );
      result = imported.ok
        ? {
            url,
            status: imported.updated ? "updated" : "imported",
            productId: imported.productId ?? undefined,
            name: product.name,
            usedAi,
            imagesMirrored: imported.imagesMirrored ?? 0,
            images: imported.images ?? 0,
            priceNote: imported.priceNote,
            variantsLinked: imported.variantsLinked ?? 0,
            merged: !!imported.mergedInto,
            mergedFields: imported.mergedFields,
          }
        : { url, status: "failed", reason: imported.error, name: product.name, usedAi };
    }
  } catch (err) {
    result = {
      url,
      status: "failed",
      reason: err instanceof Error ? err.message : "Unexpected error",
    };
  }

  if (result.status === "imported" || result.status === "updated") {
    revalidatePath("/goo-studio/products");
    revalidatePath("/");
    try {
      const cc = await clerkClient();
      const adminUser = await cc.users.getUser(admin.userId);
      void logAdminAction({
        admin_id: admin.userId,
        admin_email: adminUser.emailAddresses[0]?.emailAddress,
        action: "parser.collect_ingest",
        target_type: "product",
        target_id: result.productId,
        metadata: { url, status: result.status },
      });
    } catch {
      /* non-critical */
    }
  }

  return NextResponse.json({ ok: true, result });
}
