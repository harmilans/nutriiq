create or replace function get_leaderboard(
  p_mode      text    default 'overall',
  p_min_scans integer default 1
)
returns table (
  city          text,
  avg_score     numeric,
  scan_count    bigint,
  trend_7d      numeric
)
language plpgsql
security definer
as $$
declare
  v_col text;
  v_invert boolean := false;
begin
  if p_mode = 'protein' then
    v_col := 'protein_per_100kcal';
  elsif p_mode = 'sugar' then
    v_col := 'sugar_per_100g';
    v_invert := true;
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
