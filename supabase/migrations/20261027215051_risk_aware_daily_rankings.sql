-- Risk-aware research screen. Candidates need at least 20 prior daily bars;
-- the screen intentionally returns fewer than ten rather than padding with
-- assets that have inadequate history. Scores are relative within today's
-- source candidate set and are not probabilities of positive returns.
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
  history_dedup as (
    select distinct on (p.asset_id, p.market_date)
      p.asset_id, p.market_date, p.close::numeric as close
    from public.daily_prices p
    join public.asset_instruments i on i.id = p.asset_id
    where p.market_date < current_date
      and p.close > 0
      and p.interval in ('alpha_daily_100', 'coinbase_1d_350', 'kraken_1d_720')
    order by p.asset_id, p.market_date,
      case
        when i.asset_type = 'stock' and p.interval = 'alpha_daily_100' then 1
        when i.asset_type = 'crypto' and p.interval = 'coinbase_1d_350' then 1
        else 2
      end,
      p.observed_at desc
  ),
  history_ordered as (
    select h.*,
      row_number() over (partition by h.asset_id order by h.market_date desc) as observation_rank,
      lag(h.close) over (partition by h.asset_id order by h.market_date) as previous_close,
      max(h.close) over (
        partition by h.asset_id order by h.market_date
        rows between 19 preceding and current row
      ) as rolling_peak_20
    from history_dedup h
  ),
  history_metrics as (
    select asset_id,
      count(*)::integer as history_bars,
      max(close) filter (where observation_rank = 5) as close_5_bars_ago,
      max(close) filter (where observation_rank = 20) as close_20_bars_ago,
      stddev_samp(100 * ln(close / previous_close)) filter (
        where observation_rank <= 20 and previous_close > 0
      ) as volatility_20d_pct,
      min(100 * ((close / nullif(rolling_peak_20, 0)) - 1)) filter (
        where observation_rank <= 20
      ) as drawdown_20d_pct
    from history_ordered
    group by asset_id
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
    select 'stock'::text as asset_type, i.id as asset_id, i.symbol, i.name,
      nullif(replace(p.raw_metadata->>'change_percentage', '%', ''), '')::numeric as change_pct,
      p.close::numeric as last_price,
      (p.close * p.volume)::numeric as turnover,
      coalesce(n.mentions, 0) as mentions,
      p.observed_at,
      h.history_bars,
      ((p.close / nullif(h.close_5_bars_ago, 0)) - 1) * 100 as momentum_5d_pct,
      ((p.close / nullif(h.close_20_bars_ago, 0)) - 1) * 100 as momentum_20d_pct,
      h.volatility_20d_pct,
      h.drawdown_20d_pct
    from latest_prices p
    join public.market_sources s on s.id = p.source_id and s.source_key = 'alpha_vantage_us_movers'
    join public.asset_instruments i on i.id = p.asset_id
    join history_metrics h on h.asset_id = i.id
    left join news n on n.asset_id = i.id
    where p.interval = 'eod_mover_snapshot'
      and i.asset_type = 'stock' and i.cik is not null
      and i.symbol !~* '([./-](W|WS|WT|U|R|P))$'
      and p.close >= 5 and p.volume >= 1000000
      and (p.close * p.volume) >= 1000000
      and p.raw_metadata->>'change_percentage' ~ '^-?[0-9]+([.][0-9]+)?%$'
      and nullif(replace(p.raw_metadata->>'change_percentage', '%', ''), '')::numeric > 0
      and h.history_bars >= 20
      and h.close_5_bars_ago > 0 and h.close_20_bars_ago > 0
      and h.volatility_20d_pct is not null and h.drawdown_20d_pct is not null

    union all

    select 'crypto'::text as asset_type, i.id as asset_id, i.symbol, i.name,
      ((p.close / nullif(p.open, 0)) - 1) * 100 as change_pct,
      p.close::numeric as last_price,
      (p.close * p.volume)::numeric as turnover,
      coalesce(n.mentions, 0) as mentions,
      p.observed_at,
      h.history_bars,
      ((p.close / nullif(h.close_5_bars_ago, 0)) - 1) * 100 as momentum_5d_pct,
      ((p.close / nullif(h.close_20_bars_ago, 0)) - 1) * 100 as momentum_20d_pct,
      h.volatility_20d_pct,
      h.drawdown_20d_pct
    from latest_prices p
    join public.market_sources s on s.id = p.source_id and s.source_key = 'kraken_usd_markets'
    join public.asset_instruments i on i.id = p.asset_id
    join history_metrics h on h.asset_id = i.id
    left join news n on n.asset_id = i.id
    where p.interval = '24h_snapshot'
      and i.asset_type = 'crypto'
      and p.open > 0 and p.close > 0 and p.volume > 0
      and (p.close * p.volume) >= 1000000
      and ((p.close / nullif(p.open, 0)) - 1) * 100 > 0
      and h.history_bars >= 20
      and h.close_5_bars_ago > 0 and h.close_20_bars_ago > 0
      and h.volatility_20d_pct is not null and h.drawdown_20d_pct is not null
  ),
  scored_base as (
    select c.*,
      case when count(*) over (partition by c.asset_type) = 1 then 50::numeric else 100 * (
        0.20 * percent_rank() over (partition by c.asset_type order by c.change_pct) +
        0.15 * percent_rank() over (partition by c.asset_type order by c.momentum_5d_pct) +
        0.15 * percent_rank() over (partition by c.asset_type order by c.momentum_20d_pct) +
        0.20 * percent_rank() over (partition by c.asset_type order by ln(1 + c.turnover)) +
        0.15 * percent_rank() over (partition by c.asset_type order by c.volatility_20d_pct desc) +
        0.15 * percent_rank() over (partition by c.asset_type order by c.drawdown_20d_pct asc)
      ) end as score
    from candidates c
  ),
  ranked as (
    select sb.*,
      row_number() over (partition by sb.asset_type order by sb.score desc, sb.change_pct desc) as rank
    from scored_base sb
  )
  insert into public.daily_rankings (
    market_date, asset_type, asset_id, symbol, name, rank, score,
    change_pct, last_price, approx_usd_turnover, news_mentions, observed_at, method_version
  )
  select current_date, asset_type, asset_id, symbol, name, rank, score,
    change_pct, last_price, turnover, mentions, observed_at, 'risk-aware-screen-v2'
  from ranked
  where rank <= 10
  order by asset_type, rank;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$function$;
