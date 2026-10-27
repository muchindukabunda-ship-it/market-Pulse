create table if not exists public.market_predictions (
  id uuid primary key default gen_random_uuid(),
  target_date date not null,
  asset_type text not null check (asset_type in ('stock','crypto')),
  asset_id uuid not null references public.asset_instruments(id),
  symbol text not null,
  name text not null,
  rank integer not null check (rank > 0),
  score numeric,
  snapshot_price numeric,
  source_market_date date not null,
  source_generated_at timestamptz,
  method_version text not null default 'momentum-liquidity-v1',
  result_close numeric,
  result_return_pct numeric,
  evaluated_at timestamptz,
  forecasted_at timestamptz not null default now(),
  constraint market_predictions_once_per_target unique (target_date, asset_type, asset_id)
);

create index if not exists market_predictions_evaluation_idx
  on public.market_predictions (target_date, evaluated_at);

alter table public.market_predictions enable row level security;
revoke all on table public.market_predictions from anon, authenticated;
grant all on table public.market_predictions to service_role;
