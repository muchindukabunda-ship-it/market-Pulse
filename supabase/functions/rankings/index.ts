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

  return json({
    market_date: marketDate,
    generated_at: generatedAt,
    scoring_method: "momentum-liquidity-v1",
    limitations: [
      "Experimental momentum/liquidity screen; not a buy recommendation.",
      "Ranking scores remain snapshot-based. Historical charts do not change the score and are not a backtest.",
      "News sentiment is not included in the score.",
    ],
    stocks: rows.filter((row: { asset_type: string }) => row.asset_type === "stock"),
    crypto: rows.filter((row: { asset_type: string }) => row.asset_type === "crypto"),
  });
});