-- Who a store's unmarked pieces are for.
--
-- A store's site has "Men" and "Women" sections, or only "All" and "Women",
-- and a product page rarely says which section it came from. What "All" means
-- is the brand's convention: men's at one, unisex at the next. The importer
-- cannot read that off a page, so the admin states it once per domain here,
-- and every import from that domain whose page names no gender takes it.
--
-- NULL means "no setting": the importer falls back to what the catalogue's
-- history says about the brand and the store, and otherwise leaves gender empty.
--
-- Idempotent: safe to re-run. Requires 018_retailer_domains.sql.

alter table public.retailer_domains
  add column if not exists default_gender text
  check (default_gender is null or default_gender in ('men', 'women', 'unisex'));
