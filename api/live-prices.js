module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const symbols = String(req.query.symbols || "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^[A-Z0-9]{2,12}$/.test(value))
    .slice(0, 10);
  if (!symbols.length) return res.status(200).json({ quotes: {}, refreshed_at: new Date().toISOString() });

  const now = new Date();
  const start = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
  const end = Math.floor(now.getTime() / 1000);
  const refreshedAt = now.toISOString();

  const results = await Promise.all(symbols.map(async (symbol) => {
    const product = encodeURIComponent(symbol + "-USD");
    const base = "https://api.coinbase.com/api/v3/brokerage/market/products/" + product;
    const params = "?start=" + start + "&end=" + end + "&granularity=FIVE_MINUTE&limit=350";
    const candleUrl = base + "/candles" + params;
    const tickerUrl = base + "/ticker?limit=1";

    try {
      const [candleResponse, tickerResponse] = await Promise.all([
        fetch(candleUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }),
        fetch(tickerUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }),
      ]);
      if (!candleResponse.ok) throw new Error("candles unavailable");
      const payload = await candleResponse.json();
      const candles = Array.isArray(payload.candles) ? payload.candles
        .map((candle) => ({
          start: Number(candle.start),
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          volume: Number(candle.volume),
        }))
        .filter((candle) => Number.isFinite(candle.start) && Number.isFinite(candle.close) && candle.close > 0)
        .sort((a, b) => a.start - b.start) : [];

      const volumeSum = candles.reduce((sum, candle) => sum + (Number.isFinite(candle.volume) && candle.volume > 0 ? candle.volume : 0), 0);
      const averageNumerator = candles.reduce((sum, candle) => {
        if (!Number.isFinite(candle.volume) || candle.volume <= 0) return sum;
        const typical = (candle.high + candle.low + candle.close) / 3;
        return sum + typical * candle.volume;
      }, 0);
      const latestCandle = candles[candles.length - 1] || null;
      let currentPrice = latestCandle?.close ?? null;
      let quoteTime = latestCandle ? new Date(latestCandle.start * 1000).toISOString() : null;
      let quoteMode = "5-minute candle";
      let live = Boolean(latestCandle && end - latestCandle.start <= 600);

      if (tickerResponse.ok) {
        const ticker = await tickerResponse.json();
        const trades = Array.isArray(ticker.trades) ? ticker.trades : [];
        const trade = trades
          .filter((item) => Number.isFinite(Number(item.price)) && Number(item.price) > 0)
          .sort((a, b) => new Date(b.time || b.timestamp || 0).getTime() - new Date(a.time || a.timestamp || 0).getTime())[0];
        if (trade) {
          currentPrice = Number(trade.price);
          quoteTime = trade.time || trade.timestamp || refreshedAt;
          live = true;
          quoteMode = "Coinbase latest trade";
        }
      }

      return [symbol, {
        current_price: currentPrice,
        day_average: volumeSum > 0 ? averageNumerator / volumeSum : null,
        quote_time: quoteTime,
        refreshed_at: refreshedAt,
        source: "Coinbase public market data",
        quote_mode: quoteMode,
        live,
        bars_today: candles.length,
      }];
    } catch {
      return [symbol, {
        current_price: null,
        day_average: null,
        quote_time: null,
        refreshed_at: refreshedAt,
        source: null,
        quote_mode: "last stored price",
        live: false,
        bars_today: 0,
      }];
    }
  }));

  return res.status(200).json({
    refreshed_at: refreshedAt,
    average_method: "5-minute OHLC typical-price volume-weighted estimate",
    quotes: Object.fromEntries(results),
  });
};
