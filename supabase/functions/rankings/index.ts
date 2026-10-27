const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const sharedSecret = Deno.env.get("INGEST_SECRET") ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function nextDate(date: string, weekdaysOnly: boolean) {
  const result = new Date(date + "T00:00:00.000Z");
  result.setUTCDate(result.getUTCDate() + 1);
  if (weekdaysOnly) {
    while (result.getUTCDay() === 0 || result.getUTCDay() === 6) result.setUTCDate(result.getUTCDate() + 1);
  }
  return result.toISOString().slice(0, 10);
}

async function predictionsFor(rows: Array<Record<string, any>>, marketDate: string, generatedAt: string | null) {
  const predictionsUrl = new URL("/rest/v1/market_predictions", supabaseUrl);
  const baseHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json",
  };

  // Settle older forecasts only when the collector has a closing bar for the target date.
  try {
    const pendingUrl = new URL(predictionsUrl);
    pendingUrl.searchParams.set("target_date", `lte.${marketDate}`);
    pendingUrl.searchParams.set("evaluated_at", "is.null");
    pendingUrl.searchParams.set("select", "id,target_date,asset_type,asset_id,snapshot_price");
    pendingUrl.searchParams.set("limit", "1000");
    const pendingResponse = await fetch(pendingUrl, { headers: baseHeaders });
    if (pendingResponse.ok) {
      const pending = await pendingResponse.json() as Array<Record<string, any>>;
      const byDate = new Map<string, Array<Record<string, any>>>();
      for (const item of pending) {
        const group = byDate.get(item.target_date) ?? [];
        group.push(item);
        byDate.set(item.target_date, group);
      }
      for (const [date, items] of byDate) {
        const ids = [...new Set(items.map((item) => item.asset_id))];
        const pricesUrl = new URL("/rest/v1/daily_prices", supabaseUrl);
        pricesUrl.searchParams.set("asset_id", "in.(" + ids.join(",") + ")");
        pricesUrl.searchParams.set("market_date", "eq." + date);
        pricesUrl.searchParams.set("interval", "in.(alpha_daily_100,coinbase_1d_350,kraken_1d_720)");
        pricesUrl.searchParams.set("select", "asset_id,close,interval");
        pricesUrl.searchParams.set("order", "interval.asc");
        const pricesResponse = await fetch(pricesUrl, { headers: baseHeaders });
        if (!pricesResponse.ok) continue;
        const closes = new Map<string, number>();
        for (const price of await pricesResponse.json() as Array<Record<string, any>>) {
          const close = Number(price.close);
          if (Number.isFinite(close) && close > 0 && !closes.has(price.asset_id)) closes.set(price.asset_id, close);
        }
        await Promise.all(items.map(async (item) => {
          const close = closes.get(item.asset_id);
          const start = Number(item.snapshot_price);
          if (!close || !Number.isFinite(start) || start <= 0) return;
          const patchUrl = new URL("/rest/v1/market_predictions", supabaseUrl);
          patchUrl.searchParams.set("id", "eq." + item.id);
          await fetch(patchUrl, {
            method: "PATCH",
            headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({
              result_close: close,
              result_return_pct: ((close / start) - 1) * 100,
              evaluated_at: new Date().toISOString(),
            }),
          });
        }));
      }
    }
  } catch {
    // Leave outcomes pending; a later dashboard refresh can retry.
  }

  // Stocks forecast the next weekday; crypto forecasts the next calendar day.
  const stockTarget = nextDate(marketDate, true);
  const cryptoTarget = nextDate(marketDate, false);
  const candidates = rows.filter((row) => row.asset_id && row.symbol && Number(row.last_price) > 0);
  const forecastRows = candidates.map((row) => ({
    target_date: row.asset_type === "stock" ? stockTarget : cryptoTarget,
    asset_type: row.asset_type,
    asset_id: row.asset_id,
    symbol: row.symbol,
    name: row.name,
    rank: Number(row.rank),
    score: row.score,
    snapshot_price: row.last_price,
    source_market_date: marketDate,
    source_generated_at: generatedAt,
    method_version: row.method_version || "momentum-liquidity-v1",
  }));
  if (forecastRows.length) {
    try {
      const upsertUrl = new URL(predictionsUrl);
      upsertUrl.searchParams.set("on_conflict", "target_date,asset_type,asset_id");
      await fetch(upsertUrl, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(forecastRows),
      });
    } catch {
      // The live rankings remain available even if forecast logging has a temporary error.
    }
  }

  const targetDates = [...new Set([stockTarget, cryptoTarget])];
  const forecastUrl = new URL(predictionsUrl);
  forecastUrl.searchParams.set("target_date", "in.(" + targetDates.join(",") + ")");
  forecastUrl.searchParams.set("select", "target_date,asset_type,symbol,name,rank,score,snapshot_price,source_market_date,source_generated_at,method_version,forecasted_at,result_close,result_return_pct,evaluated_at");
  forecastUrl.searchParams.set("order", "asset_type.asc,rank.asc");
  const forecastResponse = await fetch(forecastUrl, { headers: baseHeaders });
  if (!forecastResponse.ok) return null;
  const forecasts = await forecastResponse.json() as Array<Record<string, any>>;

  const historyUrl = new URL(predictionsUrl);
  historyUrl.searchParams.set("evaluated_at", "not.is.null");
  historyUrl.searchParams.set("select", "asset_type,result_return_pct");
  historyUrl.searchParams.set("order", "target_date.desc");
  historyUrl.searchParams.set("limit", "1000");
  let evaluated: Array<Record<string, any>> = [];
  try {
    const historyResponse = await fetch(historyUrl, { headers: baseHeaders });
    if (historyResponse.ok) evaluated = await historyResponse.json();
  } catch {
    evaluated = [];
  }
  const trackRecord: Record<string, { evaluated: number; positive_return_pct: number | null; average_return_pct: number | null }> = {};
  for (const assetType of ["stock", "crypto"]) {
    const outcomes = evaluated.filter((item) => item.asset_type === assetType)
      .map((item) => Number(item.result_return_pct)).filter(Number.isFinite);
    trackRecord[assetType] = {
      evaluated: outcomes.length,
      positive_return_pct: outcomes.length ? outcomes.filter((value) => value > 0).length / outcomes.length * 100 : null,
      average_return_pct: outcomes.length ? outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length : null,
    };
  }
  return {
    stock_target_date: stockTarget,
    crypto_target_date: cryptoTarget,
    forecasted_at: new Date().toISOString(),
    method: "momentum-liquidity-v1",
    performance_note: "Historical next-session returns; descriptive only, not a validated or self-training model.",
    stocks: forecasts.filter((item) => item.asset_type === "stock"),
    crypto: forecasts.filter((item) => item.asset_type === "crypto"),
    track_record: trackRecord,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json({ error: "GET required" }, 405);
  if (!supabaseUrl || !serviceKey || !sharedSecret) return json({ error: "server configuration missing" }, 503);
  if (req.headers.get("x-market-pulse-secret") !== sharedSecret) return json({ error: "unauthorized" }, 401);

  const marketDate = new Date().toISOString().slice(0, 10);
  const endpoint = new URL("/rest/v1/daily_rankings", supabaseUrl);
  endpoint.searchParams.set("market_date", `eq.${marketDate}`);
  endpoint.searchParams.set("select", "market_date,asset_type,asset_id,symbol,name,rank,score,change_pct,last_price,approx_usd_turnover,news_mentions,observed_at,method_version,generated_at");
  endpoint.searchParams.set("order", "asset_type.asc,rank.asc");

  const result = await fetch(endpoint, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
    },
  });
  if (!result.ok) return json({ error: "ranking data unavailable" }, 502);

  const rows = await result.json();
  const assetIds = [...new Set(rows.map((row: { asset_id: string }) => row.asset_id).filter(Boolean))];
  const historyByAsset = new Map<string, Array<{ date: string; close: number; interval: string }>>();
  if (assetIds.length) {
    try {
      const cutoff = new Date(Date.now() - 89 * 86400 * 1000).toISOString().slice(0, 10);
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const historyUrl = new URL("/rest/v1/daily_prices", supabaseUrl);
        historyUrl.searchParams.set("asset_id", "in.(" + assetIds.join(",") + ")");
        historyUrl.searchParams.set("market_date", "gte." + cutoff);
        historyUrl.searchParams.set("interval", "in.(alpha_daily_100,coinbase_1d_350,kraken_1d_720)");
        historyUrl.searchParams.set("select", "asset_id,market_date,close,interval");
        historyUrl.searchParams.set("order", "asset_id.asc,market_date.asc,interval.asc");
        const page = await fetch(historyUrl, {
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            Accept: "application/json",
            "Range-Unit": "items",
            Range: `${offset}-${offset + pageSize - 1}`,
          },
        });
        if (!page.ok) throw new Error("history unavailable");
        const batch = await page.json();
        for (const bar of batch as Array<{ asset_id: string; market_date: string; close: number | string; interval: string }>) {
          const close = Number(bar.close);
          if (!Number.isFinite(close) || close <= 0) continue;
          const points = historyByAsset.get(bar.asset_id) ?? [];
          const existingIndex = points.findIndex((point) => point.date === bar.market_date);
          // Interval order makes Coinbase preferred over Kraken for crypto; Kraken fills gaps.
          if (existingIndex < 0) points.push({ date: bar.market_date, close, interval: bar.interval });
          historyByAsset.set(bar.asset_id, points);
        }
        if (batch.length < pageSize) break;
        offset += pageSize;
      }
      for (const points of historyByAsset.values()) points.sort((a, b) => a.date.localeCompare(b.date));
    } catch {
      historyByAsset.clear();
    }
  }
  for (const row of rows as Array<{ asset_id: string; history?: unknown }>) {
    const points = historyByAsset.get(row.asset_id) ?? [];
    row.history = points.map(({ date, close }) => ({ date, close }));
    row.history_days = points.length;
    row.history_return_pct = points.length > 1 && points[0].close > 0
      ? ((points[points.length - 1].close / points[0].close) - 1) * 100
      : null;
  }
  const generatedAt = rows.reduce((latest: string | null, row: { generated_at: string }) =>
    !latest || row.generated_at > latest ? row.generated_at : latest, null);

  const tomorrowForecast = await predictionsFor(rows as Array<Record<string, any>>, marketDate, generatedAt).catch(() => null);

  return json({
    market_date: marketDate,
    generated_at: generatedAt,
    scoring_method: "momentum-liquidity-v1",
    limitations: [
      "Experimental momentum/liquidity screen; not a buy recommendation.",
      "Tomorrow's list is a ranked watchlist, not a price target or a promise of positive returns.",
      "Historical charts do not change the score; performance tracking is descriptive and does not automatically retrain the model.",
      "News sentiment is not included in the score.",
    ],
    stocks: rows.filter((row: { asset_type: string }) => row.asset_type === "stock"),
    crypto: rows.filter((row: { asset_type: string }) => row.asset_type === "crypto"),
    tomorrow_forecast: tomorrowForecast,
  });
});