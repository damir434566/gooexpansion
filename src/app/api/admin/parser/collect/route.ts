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
