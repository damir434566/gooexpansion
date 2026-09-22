-- Migration 019: Remember what the store charged, before we said it in dollars.
--
-- The catalogue's prices are compared, not just displayed. `price_min` is what
-- the browse filter sorts on, what the stylist reads as a budget, and what the
-- search functions in migration 014 test against their `max_price_usd`
-- argument — which, as the name says, they take to be dollars. Nothing in that
-- path ever consults `products.currency`.
--
-- So a coat imported from a store that prices in hryvnia arrived as four
-- thousand dollars. The number was right and the unit was invented, and no
-- query downstream had any way to notice. The importer now converts at import
-- and writes dollars, which is what those readers already assumed they had.
--
-- A conversion is a claim about a moment, though, and these four columns are
-- what makes it checkable afterwards:
--
--   source_price      the amount the store showed
--   source_currency   the currency it showed it in, ISO 4217
--   fx_rate           units of that currency per 1 USD, the rate used
--   fx_date           the day that rate is from
--
-- All four are NULL on a product that was priced in dollars to begin with:
-- there was no conversion, so there is nothing to record. Together they mean a
-- price that looks wrong can be re-checked — was the rate wrong, or was the
-- extraction? — without going back to the store to ask.

alter table public.products
  add column if not exists source_price numeric;

alter table public.products
  add column if not exists source_currency text;

alter table public.products
  add column if not exists fx_rate numeric;

alter table public.products
  add column if not exists fx_date date;

-- The currency is written into a retailer entry and read back as a code, so
-- its shape is guarded here as well as in the importer. Three letters or
-- nothing: a symbol or a stray word in this column would be a conversion no
-- one can reproduce.
alter table public.products
  drop constraint if exists products_source_currency_shape;

alter table public.products
  add constraint products_source_currency_shape
  check (source_currency is null or source_currency ~ '^[A-Z]{3}$');

-- A rate divides a price, so zero and negative are not merely odd values, they
-- are an infinity waiting to be written into someone's catalogue.
alter table public.products
  drop constraint if exists products_fx_rate_positive;

alter table public.products
  add constraint products_fx_rate_positive
  check (fx_rate is null or fx_rate > 0);

comment on column public.products.source_price is
  'Amount the store charged, in source_currency, before the importer converted it to the dollars held in price_min and price_max. NULL when the store priced in dollars.';

comment on column public.products.source_currency is
  'ISO 4217 code the store priced in, e.g. UAH or GBP. NULL when the store priced in dollars.';

comment on column public.products.fx_rate is
  'Units of source_currency per 1 USD used for the conversion, so price_min times fx_rate returns the amount the store showed.';

comment on column public.products.fx_date is
  'Day the fx_rate is from, so a price that looks wrong can be checked against the rate that produced it.';

-- Without this PostgREST keeps serving from a schema cache that has never heard
-- of the columns, and the API answers "column products.source_price does not
-- exist" while the columns plainly exist.
notify pgrst, 'reload schema';
