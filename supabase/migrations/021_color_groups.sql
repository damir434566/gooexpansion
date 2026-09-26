-- Migration 021: the colour filter's thirteen base colours, safe to run twice.
--
-- The importer turns a store's colour word into `products.color_group_ids` by
-- looking the base colour up by name in `color_groups` (see
-- `loadColorGroups` in src/lib/server/parser/import-product.ts). Without the
-- table, or without its rows, every collected product lands with an empty
-- colour filter — the colour is read, and then has nowhere to go.
--
-- The table was so far only created by `supabase-schema.sql` and by
-- `supabase-migration-color-groups.sql` in the repository root. Neither can be
-- run as-is on a database that may or may not have it:
--
--   * `create policy if not exists` is not PostgreSQL syntax (15, 16 and 17
--     all reject it), and the SQL Editor sends a script as one query, so that
--     one line makes the whole file fail — no colours, no column.
--   * the seed's `on conflict do nothing` has no unique key to conflict on
--     (`id` is a serial), so a second run inserts all thirteen colours again
--     and the filter shows two of each.
--
-- This file does the same work and can be run on any of those states: no
-- table, the table without rows, or the table already seeded. A colour is
-- inserted only when no row of that name exists yet, so ids already written
-- into `products.color_group_ids` keep pointing at the same rows.
--
-- The names and swatches match DEFAULT_COLOR_GROUPS in src/lib/data/db.ts.

create table if not exists public.color_groups (
  id         serial      primary key,
  name       text        not null,
  hex_code   text        not null,
  sort_order int         not null default 0
);

alter table public.color_groups enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'color_groups'
       and policyname = 'Public read access'
  ) then
    create policy "Public read access"
      on public.color_groups
      for select
      using (true);
  end if;
end
$$;

insert into public.color_groups (name, hex_code, sort_order)
select v.name, v.hex_code, v.sort_order
  from (values
    ('White',      '#ffffff',      1),
    ('Multicolor', '#multicolor',  2),
    ('Brown',      '#7a4f35',      3),
    ('Pink',       '#e8698a',      4),
    ('Yellow',     '#f5c518',      5),
    ('Orange',     '#e87722',      6),
    ('Grey',       '#808080',      7),
    ('Black',      '#111111',      8),
    ('Green',      '#2d6a3f',      9),
    ('Red',        '#c0392b',      10),
    ('Violet',     '#7b3fa0',      11),
    ('Blue',       '#1a47a0',      12),
    ('Beige',      '#d4c5a9',      13)
  ) as v(name, hex_code, sort_order)
 where not exists (
   select 1 from public.color_groups g
    where lower(trim(g.name)) = lower(v.name)
 )
 -- On an empty table this hands out ids 1–13 in the fallback list's order.
 order by v.sort_order;

alter table public.products
  add column if not exists color_group_ids int[] not null default '{}';

create index if not exists products_color_group_ids_idx
  on public.products using gin (color_group_ids);

notify pgrst, 'reload schema';
