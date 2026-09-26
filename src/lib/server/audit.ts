import { createClient } from "@supabase/supabase-js";

export type AdminAction =
  | "user.name_updated"
  | "user.plan_changed"
  | "user.admin_granted"
  | "user.admin_revoked"
  | "user.banned"
  | "user.unbanned"
  | "user.deleted"
  | "settings.api_key_updated"
  | "settings.api_key_deleted"
  | "settings.homepage_showcase_updated"
  | "settings.homepage_stylist_updated"
  | "parser.config_updated"
  | "parser.product_imported"
  | "parser.crawl_batch"
  | "parser.collect_ingest"
  | "categories.updated"
  | "products.recategorized"
  | "products.recategorize_undone"
  | "products.label_fixed"
  | "products.bulk_edited"
  | "products.bg_color_sampled"
  | "products.bg_color_undone"
  | "products.duplicates_merged"
  | "products.duplicates_dismissed"
  | "products.colour_group_split"
  | "retailer_domain.saved"
  | "retailer_domain.deleted"
  | "retailer_domain.applied";

interface AuditEntry {
  admin_id: string;
  admin_email?: string;
  action: AdminAction;
  target_id?: string;
  target_type?: string;
  metadata?: Record<string, unknown>;
}

/** Fire-and-forget: write an admin action to the audit log. */
export async function logAdminAction(entry: AuditEntry): Promise<void> {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;

    const sb = createClient(url, key);
    await sb.from("admin_audit_log").insert({
      admin_id: entry.admin_id,
      admin_email: entry.admin_email ?? null,
      action: entry.action,
      target_id: entry.target_id ?? null,
      target_type: entry.target_type ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch {
    // Audit log failure is non-critical — never block the main response.
  }
}
