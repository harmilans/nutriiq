-- =====================================================
-- NutriIQ by Phab — Supabase Schema
-- Run this in the Supabase SQL Editor
-- =====================================================

-- SCANS TABLE
create table if not exists public.scans (
  id                       uuid        default gen_random_uuid() primary key,
  created_at               timestamptz default now() not null,
  city                     text,
  product_name             text,
  nutri_iq_score           integer     check (nutri_iq_score between 0 and 100),
  tier_label               text,
  protein_per_100kcal      float,
  sugar_per_100g           float,
  calories_per_100g        float,
  fibre_per_100g           float,
  has_artificial_additives boolean,
  ingredients_count        integer,
  ip_hash                  text
);

-- Indexes
create index if not exists scans_city_created
  on public.scans (city, created_at desc)
  where city is not null;

create index if not exists scans_created_at
  on public.scans (created_at desc);

-- Row level security
alter table public.scans enable row level security;

create policy "Public read" on public.scans
  for select using (true);

create policy "Service write" on public.scans
  for insert with check (true);
