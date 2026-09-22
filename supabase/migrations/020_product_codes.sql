-- Migration 020: The codes that identify an item rather than a listing.
--
-- A collect run imports pages, and a page belongs to one store. So the same coat
-- collected from two retailers became two products, each with one "where to buy"
-- link, and nothing in the catalogue knew they were the same coat.
--
-- What tells them apart from two similar coats is a code:
--
--   gtin  the item's own number (EAN/UPC), issued once for the whole world.
--         Two rows carrying the same GTIN are the same thing, whoever sells it.
--         Stored only after its check digit verifies, so a style code or a
--         timestamp that happened to sit in the field cannot match anything.
--   mpn   the maker's part number. Unique within a brand, so it identifies an
--         item when the brand matches too.
--   sku   the store's own shelf label. Kept for reference and deliberately NOT
--         matched on across stores: two retailers use the same SKU string for
--         different things often enough that a match would link a coat to a
--         stranger, and a wrong "also available at" link reads as correct.
--
-- The importer uses gtin, then brand+mpn, to add a second store to an existing
-- product instead of writing a second product.

alter table public.products
  add column if not exists gtin text;

alter table public.products
  add column if not exists mpn text;

alter table public.products
  add column if not exists sku text;

-- Digits only, and only the lengths GS1 issues. The check digit is verified in
-- the importer; this is the shape guard, so a hand edit cannot put a sentence
-- where a number belongs.
alter table public.products
  drop constraint if exists products_gtin_shape;

alter table public.products
  add constraint products_gtin_shape
  check (gtin is null or gtin ~ '^[0-9]{8}$' or gtin ~ '^[0-9]{12,14}$');

-- The lookups the importer makes per product: one by gtin, one by brand and mpn.
-- Partial, because most rows will carry neither and an index over those nulls
-- would be dead weight.
create index if not exists products_gtin_idx
  on public.products (gtin)
  where gtin is not null;

create index if not exists products_brand_mpn_idx
  on public.products (brand, mpn)
  where mpn is not null;

comment on column public.products.gtin is
  'EAN/UPC of the item, digits only, check digit verified before storing. Two rows with the same value are the same item sold by different stores.';

comment on column public.products.mpn is
  'Manufacturer part number. Identifies the item within its brand, so it is matched together with brand.';

comment on column public.products.sku is
  'The source stores own article number. Reference only: SKU strings are not unique between retailers and are never matched across them.';

-- Without this PostgREST keeps serving from a schema cache that has never heard
-- of the columns.
notify pgrst, 'reload schema';
