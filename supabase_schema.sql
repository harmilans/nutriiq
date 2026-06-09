-- =====================================================
-- NutriIQ by Phab — Supabase Schema
-- Run this in the Supabase SQL Editor
-- =====================================================

-- SCANS TABLE
create table if not exists public.scans (
  id              uuid        default gen_random_uuid() primary key,
  created_at      timestamptz default now() not null,
  city            text,
  product_name    text,
  nutri_iq_score  integer     check (nutri_iq_score between 0 and 100),
  tier_label      text,
  protein_per_100kcal  float,
  sugar_per_100g       float,
  calories_per_100g    float,
  fibre_per_100g       float,
  has_artificial_additives boolean,
  ingredients_count    integer,
  ip_hash         text        -- hashed, non-reversible, for dedup only
);

-- Indexes for leaderboard queries
create index if not exists scans_city_created
  on public.scans (city, created_at desc)
  where city is not null;

create index if not exists scans_created_at
  on public.scans (created_at desc);

-- Row level security (read-only for anon, write via service key only)
alter table public.scans enable row level security;

create policy "Public read" on public.scans
  for select using (true);

create policy "Service write" on public.scans
  for insert with check (true); -- Enforced by using service key in API only


-- =====================================================
-- LEADERBOARD RPC FUNCTION
-- Called by api/leaderboard.js
-- =====================================================

create or replace function get_leaderboard(
  p_mode      text    default 'overall',
  p_min_scans integer default 10
)
returns table (
  city          text,
  avg_score     numeric,
  scan_count    bigint,
  trend_7d      numeric  -- change vs prior 7 days
)
language plpgsql
security definer
as $$
declare
  v_col text;
  v_invert boolean := false;
begin

  -- Select metric column based on mode
  if p_mode = 'protein' then
    v_col := 'protein_per_100kcal';
  elsif p_mode = 'sugar' then
    v_col := 'sugar_per_100g';
    v_invert := true;  -- Lower sugar = better, so we invert
  else
    v_col := 'nutri_iq_score';
  end if;

  return query execute format(
    'with current_period as (
      select
        city,
        avg(%I) as avg_val,
        count(*) as cnt
      from scans
      where
        created_at > now() - interval ''7 days''
        and city is not null
        and %I is not null
      group by city
      having count(*) >= %s
    ),
    prior_period as (
      select
        city,
        avg(%I) as avg_val
      from scans
      where
        created_at between now() - interval ''14 days'' and now() - interval ''7 days''
        and city is not null
        and %I is not null
      group by city
    )
    select
      c.city,
      round(case when %s then (100 - c.avg_val) else c.avg_val end::numeric, 1) as avg_score,
      c.cnt as scan_count,
      round(
        (case when %s then (100 - c.avg_val) else c.avg_val end -
         case when %s then (100 - coalesce(p.avg_val, c.avg_val)) else coalesce(p.avg_val, c.avg_val) end
        )::numeric, 1
      ) as trend_7d
    from current_period c
    left join prior_period p using (city)
    order by avg_score desc
    limit 20',
    v_col, v_col, p_min_scans,
    v_col, v_col,
    v_invert, v_invert, v_invert
  );
end;
$$;


-- =====================================================
-- WEEKLY REPORT VIEW (for automated city reports)
-- =====================================================

create or replace view weekly_city_report as
select
  city,
  round(avg(nutri_iq_score)::numeric, 1)              as avg_iq,
  count(*)                                             as total_scans,
  round(avg(protein_per_100kcal)::numeric, 1)          as avg_protein_efficiency,
  round(avg(sugar_per_100g)::numeric, 1)               as avg_sugar,
  mode() within group (order by tier_label)            as most_common_tier,
  sum(case when has_artificial_additives then 1 else 0 end)::float
    / nullif(count(*), 0) * 100                        as pct_with_additives
from scans
where created_at > now() - interval '7 days'
  and city is not null
group by city
having count(*) >= 10
order by avg_iq desc;


-- =====================================================
-- COMPETITIVE INTEL VIEW (Phab's data goldmine)
-- =====================================================

create or replace view product_intel as
select
  lower(trim(product_name))                            as product,
  count(*)                                             as scan_count,
  round(avg(nutri_iq_score)::numeric, 1)               as avg_score,
  round(avg(sugar_per_100g)::numeric, 1)               as avg_sugar,
  round(avg(protein_per_100kcal)::numeric, 1)          as avg_protein_efficiency,
  mode() within group (order by tier_label)            as modal_tier,
  array_agg(distinct city order by city)               as cities_scanned_in,
  min(created_at)::date                                as first_seen,
  max(created_at)::date                                as last_seen
from scans
where product_name is not null
  and not_a_food_label is not true
group by lower(trim(product_name))
having count(*) >= 3
order by scan_count desc;


-- =====================================================
-- SAMPLE DATA (for testing leaderboard before launch)
-- Remove before production
-- =====================================================

/*
insert into scans (city, product_name, nutri_iq_score, tier_label, protein_per_100kcal, sugar_per_100g, calories_per_100g)
values
  ('Bengaluru', 'Test Bar A', 72, 'BODY_APPROVED', 16.2, 4.1, 420),
  ('Bengaluru', 'Test Bar B', 65, 'GUT_APPROVED', 14.8, 5.2, 390),
  ('Mumbai', 'Test Bar C', 54, 'ACCEPTABLE_HUMAN', 10.1, 12.4, 480),
  ('Delhi', 'Test Bar D', 48, 'MEDIOCRE_FUEL', 8.2, 18.1, 510),
  ('Pune', 'Test Bar E', 68, 'BODY_APPROVED', 15.4, 3.8, 410);
*/
