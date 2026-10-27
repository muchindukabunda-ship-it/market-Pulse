module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const symbols = [...new Set(String(req.query.symbols || "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^[A-Z0-9.]{1,12}$/.test(value)))].slice(0, 10);
  const refreshedAt = new Date().toISOString();
  if (!symbols.length) return res.status(200).json({ quotes: {}, refreshed_at: refreshedAt, configured: false });

  const key = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) {
    return res.status(200).json({
      quotes: {},
      refreshed_at: refreshedAt,
      configured: false,
      provider: "Alpaca IEX",
    });
  }

  try {
    const url = new URL("https://data.alpaca.markets/v2/stocks/snapshots");
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("feed", "iex");
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return res.status(200).json({
        quotes: {},
        refreshed_at: refreshedAt,
        configured: true,
        provider: "Alpaca IEX",
        provider_status: response.status,
      });
    }

    const payload = await response.json();
    const now = Date.now();
    const quotes = {};
    for (const symbol of symbols) {
      const snapshot = payload[symbol];
      if (!snapshot) continue;
      const trade = snapshot.latestTrade || {};
      const daily = snapshot.dailyBar || {};
      const tradeTime = trade.t ? new Date(trade.t) : null;
      const age = tradeTime ? (now - tradeTime.getTime()) / 1000 : Infinity;
      const price = Number(trade.p);
      const dayAverage = Number(daily.vw);
      const dayOpen = Number(daily.o);
      const dayChange = Number.isFinite(price) && price > 0 && Number.isFinite(dayOpen) && dayOpen > 0
        ? ((price / dayOpen) - 1) * 100
        : null;
      quotes[symbol] = {
        current_price: Number.isFinite(price) && price > 0 ? price : null,
        change_pct: dayChange,
        day_average: Number.isFinite(dayAverage) && dayAverage > 0 ? dayAverage : null,
        quote_time: tradeTime && Number.isFinite(tradeTime.getTime()) ? tradeTime.toISOString() : null,
        refreshed_at: refreshedAt,
        source: "Alpaca IEX market data · single exchange",
        quote_mode: "latest IEX trade",
        live: Number.isFinite(age) && age >= -30 && age <= 120,
        bars_today: Number(daily.n) || 0,
        feed: "IEX (single exchange)",
      };
    }
    return res.status(200).json({ quotes, refreshed_at: refreshedAt, configured: true, provider: "Alpaca IEX" });
  } catch {
    return res.status(200).json({ quotes: {}, refreshed_at: refreshedAt, configured: Boolean(key && secret), provider: "Alpaca IEX" });
  }
};
