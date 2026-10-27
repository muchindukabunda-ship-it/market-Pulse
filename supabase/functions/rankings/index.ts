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

  // Evaluate forecasts at 1, 5 and 20 observed sessions; do not invent results while bars are missing.
  try {
    const pendingUrl = new URL(predictionsUrl);
    pendingUrl.searchParams.set("target_date", `lte.${marketDate}`);
    pendingUrl.searchParams.set("select", "id,target_date,source_market_date,asset_type,asset_id,snapshot_price,result_close,result_5d_return_pct,result_20d_return_pct");
    pendingUrl.searchParams.set("order", "target_date.desc");
    pendingUrl.searchParams.set("limit", "1000");
    const pendingResponse = await fetch(pendingUrl, { headers: baseHeaders });
    if (pendingResponse.ok) {
      const pending = await pendingResponse.json() as Array<Record<string, any>>;
      const benchmarkRequests = await Promise.all([
        readRows("asset_instruments?asset_type=eq.stock&symbol=eq.SPY&select=id,symbol&limit=1"),
        readRows("asset_instruments?asset_type=eq.crypto&symbol=eq.BTC&select=id,symbol&limit=1"),
      ]);
      const benchmarkIds = { stock: benchmarkRequests[0][0]?.id, crypto: benchmarkRequests[1][0]?.id };
      const byDate = new Map<string, Array<Record<string, any>>>();
      for (const item of pending) {
        if (item.result_close !== null && item.result_5d_return_pct !== null && item.result_20d_return_pct !== null) continue;
        const group = byDate.get(item.target_date) ?? [];
        group.push(item);
        byDate.set(item.target_date, group);
      }
      for (const [date, items] of byDate) {
        const ids = [...new Set(items.flatMap((item) => [item.asset_id, benchmarkIds[item.asset_type as "stock" | "crypto"]]).filter(Boolean))];
        const fromDate = items.map((item) => item.source_market_date || item.target_date).sort()[0];
        const pricesUrl = new URL("/rest/v1/daily_prices", supabaseUrl);
        pricesUrl.searchParams.set("asset_id", "in.(" + ids.join(",") + ")");
        pricesUrl.searchParams.set("market_date", "gte." + fromDate);
        pricesUrl.searchParams.set("interval", "in.(alpha_daily_100,coinbase_1d_350,kraken_1d_720)");
        pricesUrl.searchParams.set("select", "asset_id,market_date,close,interval");
        pricesUrl.searchParams.set("order", "asset_id.asc,market_date.asc,interval.asc");
        pricesUrl.searchParams.set("limit", "1000");
        const pricesResponse = await fetch(pricesUrl, { headers: baseHeaders });
        if (!pricesResponse.ok) continue;
        const series = new Map<string, Map<string, number>>();
        for (const bar of await pricesResponse.json() as Array<Record<string, any>>) {
          const close = Number(bar.close);
          if (!Number.isFinite(close) || close <= 0) continue;
          const byDay = series.get(bar.asset_id) ?? new Map<string, number>();
          if (!byDay.has(bar.market_date)) byDay.set(bar.market_date, close);
          series.set(bar.asset_id, byDay);
        }
        const ordered = (assetId: string) => [...(series.get(assetId)?.entries() ?? [])].sort((a, b) => a[0].localeCompare(b[0]));
        await Promise.all(items.map(async (item) => {
          const candidateBars = ordered(item.asset_id).filter(([barDate]) => barDate >= date);
          const benchmarkId = benchmarkIds[item.asset_type as "stock" | "crypto"];
          const benchmarkBars = benchmarkId ? ordered(benchmarkId) : [];
          const benchmarkStart = benchmarkBars.filter(([barDate]) => barDate <= (item.source_market_date || date)).at(-1)?.[1];
          const startPrice = Number(item.snapshot_price);
          if (!Number.isFinite(startPrice) || startPrice <= 0) return;
          const patch: Record<string, unknown> = {};
          const horizons = [1, 5, 20] as const;
          for (const horizon of horizons) {
            const close = candidateBars[horizon - 1]?.[1];
            if (!close) continue;
            const ret = ((close / startPrice) - 1) * 100;
            const closeField = horizon === 1 ? "result_close" : `result_${horizon}d_close`;
            const returnField = horizon === 1 ? "result_return_pct" : `result_${horizon}d_return_pct`;
            if (item[returnField] === null || item[returnField] === undefined) {
              patch[closeField] = close;
              patch[returnField] = ret;
            }
            const benchmarkClose = benchmarkBars.filter(([barDate]) => barDate >= date)[horizon - 1]?.[1];
            const benchmarkRet = benchmarkStart && benchmarkClose ? ((benchmarkClose / benchmarkStart) - 1) * 100 : null;
            const benchField = `benchmark_${horizon}d_return_pct`;
            const excessField = `excess_${horizon}d_return_pct`;
            if (benchmarkRet !== null && (item[benchField] === null || item[benchField] === undefined)) {
              patch[benchField] = benchmarkRet;
              patch[excessField] = ret - benchmarkRet;
            }
            if (horizon === 1 && !item.benchmark_symbol) patch.benchmark_symbol = item.asset_type === "stock" ? "SPY" : "BTC";
          }
          if (patch.result_close !== undefined && item.evaluated_at === null) patch.evaluated_at = new Date().toISOString();
          if (!Object.keys(patch).length) return;
          const patchUrl = new URL("/rest/v1/market_predictions", supabaseUrl);
          patchUrl.searchParams.set("id", "eq." + item.id);
          await fetch(patchUrl, {
            method: "PATCH",
            headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify(patch),
          });
        }));
      }
    }
  } catch {
    // Keep missing horizons pending; the next collector run will retry after more daily bars arrive.
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
  historyUrl.searchParams.set("target_date", `lte.${marketDate}`);
  historyUrl.searchParams.set("select", "asset_type,result_return_pct,result_5d_return_pct,result_20d_return_pct,excess_1d_return_pct,excess_5d_return_pct,excess_20d_return_pct");
  historyUrl.searchParams.set("order", "target_date.desc");
  historyUrl.searchParams.set("limit", "1000");
  let evaluated: Array<Record<string, any>> = [];
  try {
    const historyResponse = await fetch(historyUrl, { headers: baseHeaders });
    if (historyResponse.ok) evaluated = await historyResponse.json();
  } catch {
    evaluated = [];
  }
  const savedForecastAt = forecasts.map((item) => String(item.forecasted_at || "")).filter(Boolean).sort()[0] || new Date().toISOString();
  const trackRecord: Record<string, any> = {};
  for (const assetType of ["stock", "crypto"]) {
    const horizons: Record<string, any> = {};
    for (const [label, field, excessField] of [["1d","result_return_pct","excess_1d_return_pct"],["5d","result_5d_return_pct","excess_5d_return_pct"],["20d","result_20d_return_pct","excess_20d_return_pct"]]) {
      const selected = evaluated.filter((item) => item.asset_type === assetType && item[field] !== null && item[field] !== undefined);
      const values = selected.map((item) => Number(item[field])).filter(Number.isFinite);
      const excess = selected.map((item) => Number(item[excessField])).filter(Number.isFinite);
      horizons[label] = {
        evaluated: values.length,
        positive_return_pct: values.length ? values.filter((value) => value > 0).length / values.length * 100 : null,
        average_return_pct: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        average_excess_pct: excess.length ? excess.reduce((sum, value) => sum + value, 0) / excess.length : null,
      };
    }
    trackRecord[assetType] = { ...horizons["1d"], horizons };
  }
  return {
    stock_target_date: stockTarget,
    crypto_target_date: cryptoTarget,
    forecasted_at: savedForecastAt,
    method: "momentum-liquidity-v1",
    performance_note: "Historical next-session returns; descriptive only, not a validated or self-training model.",
    stocks: forecasts.filter((item) => item.asset_type === "stock"),
    crypto: forecasts.filter((item) => item.asset_type === "crypto"),
    track_record: trackRecord,
  };
}

const serviceHeaders = () => ({
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  Accept: "application/json",
});

async function readRows(path: string) {
  const response = await fetch(new URL("/rest/v1/" + path, supabaseUrl), { headers: serviceHeaders() });
  if (!response.ok) return [];
  return await response.json();
}

function classifyHeadline(title: string, snippet: string) {
  const text = (title + " " + snippet).toLowerCase();
  const event = /earnings|quarterly results|revenue|guidance|outlook/.test(text) ? "Earnings/guidance"
    : /merger|acquisition|acquires|buyout|takeover/.test(text) ? "M&A"
    : /lawsuit|sues|investigation|probe|fraud|settlement/.test(text) ? "Legal/regulatory"
    : /hack|breach|exploit|outage|security incident/.test(text) ? "Security/operations"
    : /etf|approval|approved|rejected|regulator|sec filing|8-k|10-q|10-k/.test(text) ? "Filing/regulatory"
    : /launch|product|partnership|contract|deal|customer/.test(text) ? "Product/business"
    : "General";
  const positive = (text.match(/beats|beat estimates|raises guidance|upgrade|approval|approved|record revenue|profit growth|wins contract|buyback|surge|surges|rally|rallies|strong demand/g) || []).length;
  const negative = (text.match(/misses|missed estimates|cuts guidance|downgrade|lawsuit|investigation|probe|loss widens|hack|breach|recall|bankruptcy|warning|warns|plunge|plunges|slump/g) || []).length;
  const sentiment = positive > negative ? "Positive keywords"
    : negative > positive ? "Negative keywords"
    : positive && negative ? "Mixed keywords" : "No clear keyword signal";
  return { event_type: event, headline_tone: sentiment, tone_method: "headline keyword scan · low confidence" };
}

function hasStrongEntityEvidence(row: Record<string, any>, mention: Record<string, any>, article: Record<string, any>) {
  if (mention.match_type === "crypto_alias") return true;
  const text = (String(article.title || "") + " " + String(article.summary_snippet || "")).toLowerCase();
  const symbol = String(row.symbol || "").replace(/[.*+?^${}()|[\]\\]/g, "\\Deno.serve(async (req: Request) => {");
  const tickerContext = new RegExp(`(?:\\$\\s*${symbol}\\b|\\b${symbol}\\s+(?:shares|stock|price|ticker|rose|fell|gained|lost)\\b|\\b(?:shares|stock|ticker|price)\\s+(?:of|for|in)?\\s*${symbol}\\b|\\b(?:nasdaq|nyse|nasdaq:|nyse:)\\s*${symbol}\\b)`, "i");
  if (tickerContext.test(String(article.title || "") + " " + String(article.summary_snippet || ""))) return true;
  const excluded = new Set(["inc","incorporated","corp","corporation","company","co","ltd","limited","plc","holdings","group","the","and","of","class"]);
  const terms = String(row.name || "").toLowerCase().split(/[^a-z0-9]+/).filter((word: string) => word.length >= 4 && !excluded.has(word));
  return terms.length > 0 && terms.some((word: string) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\Deno.serve(async (req: Request) => {")}\\b`, "i").test(text));
}

async function buildResearchContext(rows: Array<Record<string, any>>) {
  const assetIds = [...new Set(rows.map((row) => String(row.asset_id || "")).filter(Boolean))];
  const empty = { sources: [], fresh_sources: 0, stale_sources: 0, candidate_assets: rows.length, assets_with_history: rows.filter((row) => Number(row.history_days) >= 20).length, linked_articles: 0 };
  if (!assetIds.length) return { health: empty, sources: [], news_by_asset: {} as Record<string, unknown[]> };
  try {
    const [sources, mentions] = await Promise.all([
      readRows("market_sources?select=id,source_key,name,tier,trust_score,source_kind,access_method,enabled,last_successful_at,last_error&enabled=eq.true"),
      readRows("article_asset_mentions?asset_id=in.(" + assetIds.join(",") + ")&select=asset_id,article_id,match_type,confidence,matched_text&limit=1000"),
    ]);
    const ids = [...new Set(mentions.map((item: Record<string, any>) => String(item.article_id)))];
    const articles = ids.length ? await readRows("articles?id=in.(" + ids.join(",") + ")&select=id,title,canonical_url,published_at,summary_snippet&order=published_at.desc&limit=400") : [];
    const links = ids.length ? await readRows("article_sources?article_id=in.(" + ids.join(",") + ")&select=article_id,source_id") : [];
    const sourceById = new Map((sources as Array<Record<string, any>>).map((source) => [source.id, source]));
    const articleById = new Map((articles as Array<Record<string, any>>).map((article) => [article.id, article]));
    const linksByArticle = new Map<string, Array<Record<string, any>>>();
    for (const link of links as Array<Record<string, any>>) {
      const list = linksByArticle.get(link.article_id) || [];
      const source = sourceById.get(link.source_id);
      if (source) list.push(source);
      linksByArticle.set(link.article_id, list);
    }
    const newsByAsset: Record<string, Array<Record<string, any>>> = {};
    for (const row of rows) {
      const relevant = (mentions as Array<Record<string, any>>).filter((mention) =>
        mention.asset_id === row.asset_id && Number(mention.confidence || 0) >= 0.72);
      const unique = new Map<string, Record<string, any>>();
      for (const mention of relevant) {
        const article = articleById.get(mention.article_id);
        if (!article || !hasStrongEntityEvidence(row, mention, article)) continue;
        const publishers = linksByArticle.get(article.id) || [];
        unique.set(article.id, {
          title: article.title,
          url: article.canonical_url,
          published_at: article.published_at,
          event: classifyHeadline(article.title, article.summary_snippet || ""),
          source_count: publishers.length,
          sources: publishers.slice(0, 4).map((source) => ({ name: source.name, tier: source.tier, trust_score: source.trust_score, source_kind: source.source_kind })),
          entity_match: mention.match_type === "crypto_alias" ? "asset name/alias" : "ticker/company context",
        });
      }
      newsByAsset[row.asset_id] = [...unique.values()]
        .sort((a, b) => b.source_count - a.source_count || String(b.published_at).localeCompare(String(a.published_at)))
        .slice(0, 3);
    }
    const now = Date.now();
    const dailyKeys = new Set(["sec_company_tickers","alpha_vantage_us_movers","kraken_usd_markets","coinbase_public_crypto"]);
    const sourceStatus = (sources as Array<Record<string, any>>).map((source) => {
      const ageHours = source.last_successful_at ? (now - new Date(source.last_successful_at).getTime()) / 3600000 : Infinity;
      const threshold = dailyKeys.has(source.source_key) ? 36 : 6;
      return { name: source.name, source_key: source.source_key, kind: source.source_kind, access: source.access_method, last_successful_at: source.last_successful_at, stale: ageHours > threshold, threshold_hours: threshold, last_error: source.last_error || null };
    });
    const fresh = sourceStatus.filter((source) => !source.stale).length;
    const linkedArticles = Object.values(newsByAsset).reduce((total, list) => total + list.length, 0);
    return {
      health: { sources: sourceStatus.length, fresh_sources: fresh, stale_sources: sourceStatus.length - fresh, candidate_assets: rows.length, assets_with_history: rows.filter((row) => Number(row.history_days) >= 20).length, linked_articles: linkedArticles },
      sources: sourceStatus,
      news_by_asset: newsByAsset,
    };
  } catch {
    return { health: empty, sources: [], news_by_asset: {} as Record<string, unknown[]> };
  }
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

  const researchContext = await buildResearchContext(rows as Array<Record<string, any>>);
  for (const row of rows as Array<Record<string, any>>) row.news_context = researchContext.news_by_asset[row.asset_id] || [];
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
    data_health: researchContext.health,
    source_health: researchContext.sources,
  });
});