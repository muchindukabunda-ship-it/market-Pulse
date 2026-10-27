create or replace function public.refresh_daily_rankings()
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  inserted_count integer;
begin
  delete from public.daily_rankings where market_date = current_date;

  with latest_prices as (
    select distinct on (p.asset_id, p.interval)
      p.asset_id, p.source_id, p.market_date, p.observed_at, p.interval,
      p.open, p.close, p.volume, p.raw_metadata
    from public.daily_prices p
    where p.market_date = current_date
    order by p.asset_id, p.interval, p.observed_at desc
  ),
  news as (
    select m.asset_id, count(distinct a.id)::integer as mentions
    from public.article_asset_mentions m
    join public.articles a on a.id = m.article_id
    where a.published_at >= now() - interval '24 hours'
      and m.confidence >= 0.82
    group by m.asset_id
  ),
  candidates as (
    select
      'stock'::text as asset_type, i.id as asset_id, i.symbol, i.name,
      nullif(replace(p.raw_metadata->>'change_percentage', '%', ''), '')::numeric as change_pct,
      p.close::numeric as last_price,
      (p.close * p.volume)::numeric as turnover,
      coalesce(n.mentions, 0) as mentions,
      p.observed_at
    from latest_prices p
    join public.market_sources s on s.id = p.source_id and s.source_key = 'alpha_vantage_us_movers'
    join public.asset_instruments i on i.id = p.asset_id
    left join news n on n.asset_id = i.id
    where p.interval = 'eod_mover_snapshot'
      and i.asset_type = 'stock' and i.cik is not null
      and p.close >= 5 and p.volume >= 1000000
      and p.raw_metadata->>'change_percentage' ~ '^-?[0-9]+([.][0-9]+)?%$'
      and nullif(replace(p.raw_metadata->>'change_percentage', '%', ''), '')::numeric > 0

    union all

    select
      'crypto'::text as asset_type, i.id as asset_id, i.symbol, i.name,
      ((p.close / nullif(p.open, 0)) - 1) * 100 as change_pct,
      p.close::numeric as last_price,
      (p.close * p.volume)::numeric as turnover,
      coalesce(n.mentions, 0) as mentions,
      p.observed_at
    from latest_prices p
    join public.market_sources s on s.id = p.source_id and s.source_key = 'kraken_usd_markets'
    join public.asset_instruments i on i.id = p.asset_id
    left join news n on n.asset_id = i.id
    where p.interval = '24h_snapshot'
      and i.asset_type = 'crypto'
      and p.open > 0 and p.close > 0 and p.volume > 0
      and (p.close * p.volume) >= 1000000
      and ((p.close / nullif(p.open, 0)) - 1) * 100 > 0
  ),
  scored_base as (
    select c.*,
      100 * (
        0.70 * percent_rank() over (partition by c.asset_type order by c.change_pct) +
        0.30 * percent_rank() over (partition by c.asset_type order by ln(1 + c.turnover))
      ) as score
    from candidates c
  ),
  ranked as (
    select sb.*,
      row_number() over (partition by sb.asset_type order by sb.score desc, sb.change_pct desc) as rank
    from scored_base sb
  )
  insert into public.daily_rankings (
    market_date, asset_type, asset_id, symbol, name, rank, score,
    change_pct, last_price, approx_usd_turnover, news_mentions, observed_at
  )
  select current_date, asset_type, asset_id, symbol, name, rank, score,
    change_pct, last_price, turnover, mentions, observed_at
  from ranked
  where rank <= 10
  order by asset_type, rank;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$function$;
