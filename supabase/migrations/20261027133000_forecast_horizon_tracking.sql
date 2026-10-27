alter table public.market_predictions
  add column if not exists result_5d_close numeric,
  add column if not exists result_5d_return_pct numeric,
  add column if not exists result_20d_close numeric,
  add column if not exists result_20d_return_pct numeric,
  add column if not exists benchmark_symbol text,
  add column if not exists benchmark_1d_return_pct numeric,
  add column if not exists benchmark_5d_return_pct numeric,
  add column if not exists benchmark_20d_return_pct numeric,
  add column if not exists excess_1d_return_pct numeric,
  add column if not exists excess_5d_return_pct numeric,
  add column if not exists excess_20d_return_pct numeric;
