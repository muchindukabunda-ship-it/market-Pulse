type Source = {
  id: string;
  source_key: string;
  name: string;
  tier: number;
  trust_score: number;
  source_kind: string;
  access_method: string;
  feed_url: string;
  enabled: boolean;
  last_attempted_at: string | null;
  last_successful_at: string | null;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const timeoutMs = 18_000;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function request(url: string, init: RequestInit = {}, timeout = timeoutMs) {
  const retryable = !init.method || init.method.toUpperCase() === "GET";
  const attempts = retryable ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const result = await fetch(url, { ...init, signal: controller.signal });
      if (retryable && (result.status === 429 || result.status >= 500) && attempt + 1 < attempts) {
        await result.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!retryable || attempt + 1 >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("request failed");
}

async function db(path: string, init: RequestInit = {}) {
  const res = await request(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`database ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function upsert(table: string, rows: unknown[], conflict: string) {
  if (!rows.length) return;
  await db(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

async function patchSource(sourceId: string, patch: Record<string, unknown>) {
  await db(`market_sources?id=eq.${sourceId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

function normalizeTitle(title: string) {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 500);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function canonicalUrl(raw: string) {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ocid|cmpid|source|ref)/i.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return raw.trim();
  }
}

function decodeXml(value: string) {
  return value.replace(/&#(x[\da-f]+|\d+);/gi, (_match, code: string) => {
    const number = code[0].toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
    return Number.isFinite(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
  }).replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name]);
}

function xmlField(block: string, names: string[]) {
  for (const name of names) {
    const re = new RegExp(`<(?:(?:[\\w.-]+):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${name}\\s*>`, "i");
    const match = block.match(re);
    if (match) {
      const raw = match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1");
      return decodeXml(raw.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

function xmlLink(block: string) {
  const match = block.match(/<(?:[\w.-]+:)?link\b([^>]*)\/?\s*>/i);
  const href = match?.[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
  return href ? decodeXml(href.trim()) : xmlField(block, ["link"]);
}

function parseFeed(xml: string) {
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error("unsupported or invalid XML feed");
  const records = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)];
  return records.map((record) => {
    const node = record[2];
    const link = xmlLink(node);
    const title = xmlField(node, ["title"]);
    const published = xmlField(node, ["pubDate", "published", "updated", "date"]);
    const snippet = xmlField(node, ["description", "summary", "content"]);
    const guid = xmlField(node, ["guid", "id"]);
    if (!title || !link) return null;
    const parsedDate = published ? new Date(published) : null;
    return {
      title: title.slice(0, 1000),
      url: link,
      published_at: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
      summary_snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 1200) || null,
      source_item_id: guid || null,
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null);
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

async function insertArticles(source: Source, items: ReturnType<typeof parseFeed>) {
  const incoming = [];
  for (const item of items) {
    const normalized_title = normalizeTitle(item.title);
    const canonical_url = canonicalUrl(item.url);
    incoming.push({
      title: item.title,
      normalized_title,
      title_fingerprint: await sha256(normalized_title),
      canonical_url,
      published_at: item.published_at,
      summary_snippet: item.summary_snippet,
      raw_metadata: { source_key: source.source_key, source_item_id: item.source_item_id },
    });
  }
  const uniqueByTitle = [...new Map(incoming.map((item) => [item.title_fingerprint, item])).values()];
  const uniqueIncoming = [...new Map(uniqueByTitle.map((item) => [item.canonical_url, item])).values()];
  const urls = [...new Set(incoming.map((item) => item.canonical_url))];
  const fingerprints = [...new Set(incoming.map((item) => item.title_fingerprint))];
  const encodeList = (values: string[]) => `(${values.map(encodeURIComponent).join(",")})`;
  const lookupArticles = async () => {
    const rows: Array<{ id: string; title_fingerprint: string; canonical_url: string }> = [];
    const chunkSize = 20;
    for (let offset = 0; offset < Math.max(urls.length, fingerprints.length); offset += chunkSize) {
      const filters = [];
      const urlChunk = urls.slice(offset, offset + chunkSize);
      const fingerprintChunk = fingerprints.slice(offset, offset + chunkSize);
      if (urlChunk.length) filters.push(`canonical_url.in.${encodeList(urlChunk)}`);
      if (fingerprintChunk.length) filters.push(`title_fingerprint.in.${encodeList(fingerprintChunk)}`);
      rows.push(...await db(`articles?or=(${filters.join(",")})&select=id,title_fingerprint,canonical_url`));
    }
    return rows;
  };
  const found = await lookupArticles();
  const knownUrls = new Set(found.map((a: { canonical_url: string }) => a.canonical_url));
  const knownFingerprints = new Set(found.map((a: { title_fingerprint: string }) => a.title_fingerprint));
  const toInsert = uniqueIncoming.filter((a) => !knownUrls.has(a.canonical_url) && !knownFingerprints.has(a.title_fingerprint));
  await upsert("articles", toInsert, "canonical_url");
  const resolved = await lookupArticles();
  const idByUrl = new Map(resolved.map((a: { id: string; canonical_url: string }) => [a.canonical_url, a.id]));
  const idByFingerprint = new Map(resolved.map((a: { id: string; title_fingerprint: string }) => [a.title_fingerprint, a.id]));
  const links = [];
  for (const item of items) {
    const normalized = normalizeTitle(item.title);
    const id = idByUrl.get(canonicalUrl(item.url)) ?? idByFingerprint.get(await sha256(normalized));
    if (id) links.push({ article_id: id, source_id: source.id, source_item_id: item.source_item_id, source_published_at: item.published_at });
  }
  const uniqueLinks = [...new Map(links.map((link) => [`${link.article_id}:${link.source_id}`, link])).values()];
  await upsert("article_sources", uniqueLinks, "article_id,source_id");
  const ambiguous = new Set(["CEO", "CFO", "IPO", "SEC", "USA", "USD", "THE", "ALL", "FOR", "ARE", "HAS", "NEW", "CAN", "YOU", "NOW", "TOP", "BIG", "AI", "IT", "ON", "IN", "FUND", "CARE", "OCC", "III", "CAT", "DAY", "ONE", "LOW", "HIGH", "YES", "NOW"]);
  const cryptoAliases: Record<string, string> = {
    bitcoin: "BTC", ether: "ETH", ethereum: "ETH", solana: "SOL", dogecoin: "DOGE", xrp: "XRP", ripple: "XRP",
    cardano: "ADA", litecoin: "LTC", avalanche: "AVAX", chainlink: "LINK", "binance coin": "BNB",
  };
  const candidates = new Set<string>();
  for (const item of items) {
    for (const match of `${item.title} ${item.summary_snippet ?? ""}`.matchAll(/\b[A-Z]{3,5}(?:\.[A-Z])?\b/g)) {
      if (!ambiguous.has(match[0])) candidates.add(match[0]);
    }
    const lower = `${item.title} ${item.summary_snippet ?? ""}`.toLowerCase();
    for (const [alias, symbol] of Object.entries(cryptoAliases)) {
      if (new RegExp(`\\b${escapeRegex(alias)}\\b`, "i").test(lower)) candidates.add(symbol);
    }
  }
  const assetRows = candidates.size
    ? await db(`asset_instruments?symbol=in.(${[...candidates].map(encodeURIComponent).join(",")})&active=eq.true&select=id,symbol,asset_type`)
    : [];
  const assetBySymbol = new Map(assetRows.map((a: { id: string; symbol: string; asset_type: string }) => [`${a.asset_type}:${a.symbol}`, a]));
  const mentions = [];
  for (const item of items) {
    const fingerprint = await sha256(normalizeTitle(item.title));
    const article_id = idByUrl.get(canonicalUrl(item.url)) ?? idByFingerprint.get(fingerprint);
    if (!article_id) continue;
    const body = `${item.title} ${item.summary_snippet ?? ""}`;
    const uppercaseTokens = new Set([...body.matchAll(/\b[A-Z]{3,5}(?:\.[A-Z])?\b/g)].map((m) => m[0]));
    for (const symbol of uppercaseTokens) {
      if (ambiguous.has(symbol)) continue;
      const asset = assetBySymbol.get(`stock:${symbol}`);
      if (!asset) continue;
      const escaped = escapeRegex(symbol);
      const explicitTicker = new RegExp(`(?:\\$\\s*${escaped}\\b|\\b${escaped}\\s+(?:shares|stock|price|ticker)\\b|\\b(?:shares|stock|ticker|price)\\s+(?:of|for|in)?\\s*${escaped}\\b|\\b(?:nasdaq|nyse)\\s*:?[\\s]*${escaped}\\b)`, "i");
      if (explicitTicker.test(body)) mentions.push({ article_id, asset_id: asset.id, match_type: "ticker_context", confidence: 0.92, matched_text: symbol });
    }
    const lower = body.toLowerCase();
    for (const [alias, symbol] of Object.entries(cryptoAliases)) {
      const escaped = escapeRegex(alias);
      if (!new RegExp(`\\b${escaped}\\b`, "i").test(lower)) continue;
      const asset = assetBySymbol.get(`crypto:${symbol}`);
      if (asset) mentions.push({ article_id, asset_id: asset.id, match_type: "crypto_alias", confidence: 0.82, matched_text: alias });
    }
  }
  const uniqueMentions = [...new Map(mentions.map((mention) => [`${mention.article_id}:${mention.asset_id}:${mention.match_type}`, mention])).values()];
  await upsert("article_asset_mentions", uniqueMentions, "article_id,asset_id,match_type");
  return links.length;
}

async function upsertAssets(rows: Array<Record<string, unknown>>) {
  const unique = [...new Map(rows.map((row) => [`${row.asset_type}:${row.symbol}`, row])).values()];
  for (let offset = 0; offset < unique.length; offset += 400) {
    await upsert("asset_instruments", unique.slice(offset, offset + 400), "asset_type,symbol");
  }
}

async function ingestSecUniverse() {
  const userAgent = Deno.env.get("SEC_USER_AGENT");
  if (!userAgent || !/\S+@\S+/.test(userAgent)) throw new Error("SEC_USER_AGENT must identify the app and include a contact email");
  const res = await request("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": userAgent, Accept: "application/json" } });
  if (!res.ok) throw new Error(`SEC tickers ${res.status}`);
  const payload = await res.json();
  const rows = Object.values(payload as Record<string, { cik_str: number; ticker: string; title: string }>).map((x) => ({
    asset_type: "stock", symbol: x.ticker.toUpperCase(), name: x.title, cik: String(x.cik_str).padStart(10, "0"),
    provider_symbol: x.ticker.toUpperCase(), aliases: [], active: true,
  }));
  await upsertAssets(rows);
  return rows.length;
}

function krakenSymbol(pair: Record<string, unknown>) {
  const raw = String(pair.base ?? "").replace(/^[XZ]/, "");
  const map: Record<string, string> = { XBT: "BTC", XXBT: "BTC", XDG: "DOGE", XXDG: "DOGE", XETH: "ETH", ZUSD: "USD" };
  return map[raw] ?? raw;
}


async function ingestKrakenHistory(
  source: Source,
  pairEntries: Array<[string, Record<string, unknown>]>,
  tickers: Record<string, Record<string, unknown>>,
  idBySymbol: Map<string, string>,
) {
  const ranked = pairEntries.flatMap(([pairKey, pair]) => {
    const symbol = krakenSymbol(pair);
    const asset_id = idBySymbol.get(symbol);
    const ticker = tickers[pairKey] ?? tickers[String(pair.altname ?? "")];
    const close = num(ticker?.c?.[0]);
    const volume = num(ticker?.v?.[1]);
    if (!asset_id || close === null || volume === null) return [];
    return [{ pairKey, symbol, asset_id, turnover: close * volume }];
  }).sort((a, b) => b.turnover - a.turnover);
  // Historical calls go to the highest-turnover current USD markets. Looking
  // only at yesterday's winners caused today's eligible coins to have no bars.
  const selected = ranked.slice(0, 12);
  const today = new Date().toISOString().slice(0, 10);
  const observedAt = new Date().toISOString();
  const historyRows: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1050));
    try {
      const url = "https://api.kraken.com/0/public/OHLC?pair=" + encodeURIComponent(item.pairKey) + "&interval=1440";
      const res = await request(url, {}, 9000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const payload = await res.json();
      if (payload.error?.length) throw new Error(payload.error.join(","));
      const result = payload.result as Record<string, unknown>;
      const resultKey = Object.keys(result).find((key) => key !== "last");
      const candles = resultKey ? result[resultKey] as unknown[] : [];
      for (const candle of candles) {
        if (!Array.isArray(candle) || candle.length < 7) continue;
        const marketDate = new Date(Number(candle[0]) * 1000).toISOString().slice(0, 10);
        if (marketDate >= today) continue;
        const close = num(candle[4]);
        if (close === null || close <= 0) continue;
        historyRows.push({
          asset_id: item.asset_id,
          source_id: source.id,
          market_date: marketDate,
          observed_at: observedAt,
          interval: "kraken_1d_720",
          currency: "USD",
          open: num(candle[1]),
          high: num(candle[2]),
          low: num(candle[3]),
          close,
          volume: num(candle[6]),
          raw_metadata: { provider: "Kraken", pair: item.pairKey, vwap: num(candle[5]), trade_count: num(candle[7]) },
        });
      }
    } catch {
      failures.push(item.symbol);
    }
  }
  for (let offset = 0; offset < historyRows.length; offset += 250) {
    await upsert("daily_prices", historyRows.slice(offset, offset + 250), "asset_id,source_id,market_date,interval");
  }
  return { count: historyRows.length, symbols: selected.map((item) => item.symbol), failures };
}

async function ingestKraken(source: Source, includeHistory = true) {
  const [pairsRes, tickerRes] = await Promise.all([
    request("https://api.kraken.com/0/public/AssetPairs"),
    request("https://api.kraken.com/0/public/Ticker"),
  ]);
  if (!pairsRes.ok || !tickerRes.ok) throw new Error(`Kraken HTTP ${pairsRes.status}/${tickerRes.status}`);
  const pairsPayload = await pairsRes.json();
  const tickerPayload = await tickerRes.json();
  if (pairsPayload.error?.length || tickerPayload.error?.length) throw new Error(`Kraken API error: ${[...pairsPayload.error, ...tickerPayload.error].join(",")}`);
  const pairs = pairsPayload.result as Record<string, Record<string, unknown>>;
  const tickers = tickerPayload.result as Record<string, Record<string, unknown>>;
  const pairEntries = Object.entries(pairs).filter(([, p]) => ["ZUSD", "USD"].includes(String(p.quote)));
  const symbols = [...new Set(pairEntries.map(([, p]) => krakenSymbol(p)).filter(Boolean))];
  await upsertAssets(symbols.map((symbol) => ({ asset_type: "crypto", symbol, name: symbol, exchange: "Kraken", provider_symbol: symbol, aliases: [], active: true })));
  const assets = await db(`asset_instruments?asset_type=eq.crypto&symbol=in.(${symbols.join(",")})&select=id,symbol`);
  const idBySymbol = new Map(assets.map((a: { id: string; symbol: string }) => [a.symbol, a.id]));
  const date = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const pricesByAsset = new Map<string, Record<string, unknown>>();
  for (const [pairKey, pair] of pairEntries) {
    const symbol = krakenSymbol(pair);
    const asset_id = idBySymbol.get(symbol);
    const ticker = tickers[pairKey] ?? tickers[String(pair.altname ?? "")];
    const close = num(ticker?.c?.[0]);
    if (!asset_id || !ticker || close === null) continue;
    pricesByAsset.set(asset_id, { asset_id, source_id: source.id, market_date: date, observed_at: now, interval: "24h_snapshot", close,
      open: num(ticker.o), high: num(ticker.h?.[1]), low: num(ticker.l?.[1]), volume: num(ticker.v?.[1]), raw_metadata: { pair: pairKey, altname: pair.altname } });
  }
  const prices = [...pricesByAsset.values()];
  await upsert("daily_prices", prices, "asset_id,source_id,market_date,interval");
  const history = includeHistory
    ? await ingestKrakenHistory(source, pairEntries, tickers, idBySymbol)
    : { count: 0, symbols: [] as string[], failures: [] as string[] };
  return { count: prices.length, history_count: history.count, history_symbols: history.symbols, history_failures: history.failures };
}


async function ingestCoinbasePublicHistory(source: Source) {
  const today = new Date().toISOString().slice(0, 10);
  const board = await db("daily_rankings?market_date=eq." + today + "&asset_type=eq.crypto&order=rank.asc&select=symbol&limit=10");
  const symbols = [...new Set([
    ...board.map((row: { symbol: string }) => String(row.symbol).toUpperCase()),
    "BTC",
    "ETH",
  ])].filter((symbol) => /^[A-Z0-9]{2,12}$/.test(symbol)).slice(0, 12);
  await upsertAssets(symbols.map((symbol) => ({
    asset_type: "crypto", symbol, name: symbol, provider_symbol: symbol, aliases: [], active: true,
  })));
  const assets = await db("asset_instruments?asset_type=eq.crypto&symbol=in.(" + symbols.map(encodeURIComponent).join(",") + ")&select=id,symbol");
  const idBySymbol = new Map(assets.map((a: { id: string; symbol: string }) => [a.symbol, a.id]));
  const end = Math.floor(Date.now() / 1000);
  const start = end - 350 * 86400;
  const observedAt = new Date().toISOString();
  const historyRows: Array<Record<string, unknown>> = [];
  const collected: string[] = [];
  const failures: string[] = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const asset_id = idBySymbol.get(symbol);
    if (!asset_id) { failures.push(symbol); continue; }
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1050));
    try {
      const product = encodeURIComponent(symbol + "-USD");
      const url = "https://api.coinbase.com/api/v3/brokerage/market/products/" + product +
        "/candles?start=" + start + "&end=" + end + "&granularity=ONE_DAY&limit=350";
      const res = await request(url, { headers: { Accept: "application/json" } }, 9000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const payload = await res.json();
      if (payload.error || !Array.isArray(payload.candles)) throw new Error(String(payload.error ?? "candles missing"));
      let added = 0;
      for (const candle of payload.candles as Array<Record<string, unknown>>) {
        const seconds = num(candle.start);
        const close = num(candle.close);
        if (seconds === null || close === null || close <= 0) continue;
        const marketDate = new Date(seconds * 1000).toISOString().slice(0, 10);
        if (marketDate >= today) continue;
        historyRows.push({
          asset_id, source_id: source.id, market_date: marketDate, observed_at: observedAt,
          interval: "coinbase_1d_350", currency: "USD",
          open: num(candle.open), high: num(candle.high), low: num(candle.low), close,
          volume: num(candle.volume),
          raw_metadata: { provider: "Coinbase public market data", product_id: symbol + "-USD" },
        });
        added++;
      }
      if (added) collected.push(symbol);
      else failures.push(symbol);
    } catch {
      failures.push(symbol);
    }
  }
  for (let offset = 0; offset < historyRows.length; offset += 250) {
    await upsert("daily_prices", historyRows.slice(offset, offset + 250), "asset_id,source_id,market_date,interval");
  }
  return { count: historyRows.length, symbols: collected, failures };
}

async function ingestAlphaVantageHistory(
  source: Source,
  symbols: string[],
  idBySymbol: Map<string, string>,
  apiKey: string,
) {
  const candidates = [...new Set(symbols)].slice(0, 12);
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const observedAt = new Date().toISOString();
  const collected: string[] = [];
  const failures: string[] = [];
  let count = 0;
  for (let i = 0; i < candidates.length; i++) {
    const symbol = candidates[i];
    const asset_id = idBySymbol.get(symbol);
    if (!asset_id) { failures.push(symbol); continue; }
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1050));
    try {
      const url = new URL("https://www.alphavantage.co/query");
      url.searchParams.set("function", "TIME_SERIES_DAILY");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("outputsize", "compact");
      url.searchParams.set("apikey", apiKey);
      const res = await request(url.toString(), {}, 9000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const payload = await res.json();
      if (payload.Note || payload.Information || payload["Error Message"]) throw new Error("provider limit or symbol response");
      const series = payload["Time Series (Daily)"] as Record<string, Record<string, string>> | undefined;
      if (!series) throw new Error("daily series missing");
      const rows = Object.entries(series).flatMap(([marketDate, bar]) => {
        if (marketDate >= todayET) return [];
        const close = num(bar["4. close"]);
        if (close === null || close <= 0) return [];
        return [{
          asset_id,
          source_id: source.id,
          market_date: marketDate,
          observed_at: observedAt,
          interval: "alpha_daily_100",
          currency: "USD",
          open: num(bar["1. open"]),
          high: num(bar["2. high"]),
          low: num(bar["3. low"]),
          close,
          volume: num(bar["5. volume"]),
          raw_metadata: { provider: "Alpha Vantage", adjusted: false },
        }];
      });
      for (let offset = 0; offset < rows.length; offset += 250) {
        await upsert("daily_prices", rows.slice(offset, offset + 250), "asset_id,source_id,market_date,interval");
      }
      count += rows.length;
      if (rows.length) collected.push(symbol);
      else failures.push(symbol);
    } catch {
      failures.push(symbol);
    }
  }
  return { count, symbols: collected, failures };
}

async function ingestAlphaVantage(source: Source, includeHistory = true) {
  const key = Deno.env.get("ALPHA_VANTAGE_API_KEY");
  if (!key) return { count: 0, skipped: true, note: "ALPHA_VANTAGE_API_KEY not configured", history_count: 0 };
  const today = new Date().toISOString().slice(0, 10);

  const url = new URL(source.feed_url);
  url.searchParams.set("apikey", key);
  const res = await request(url.toString());
  if (!res.ok) throw new Error("Alpha Vantage " + res.status);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload["Error Message"]) throw new Error(String(payload.Note ?? payload.Information ?? payload["Error Message"]));
  const gainers = payload.top_gainers ?? [];
  const losers = payload.top_losers ?? [];
  const active = payload.most_actively_traded ?? [];
  const movers = [...new Map([...gainers, ...losers, ...active].map((m: Record<string, string>) => [String(m.ticker).toUpperCase(), m])).values()];
  const symbols = [...new Set(movers.map((m: Record<string, string>) => String(m.ticker).toUpperCase()).filter(Boolean))];
  const currentBoard = await db("daily_rankings?market_date=eq." + today + "&asset_type=eq.stock&order=rank.asc&select=symbol&limit=10");
  const boardSymbols = currentBoard.map((row: { symbol: string }) => String(row.symbol).toUpperCase());
  // Spend the limited daily-bar calls on the same liquid, positive movers the
  // ranking screen is eligible to consider, not yesterday's board or raw
  // provider order. Keep one slot for SPY as the equity benchmark.
  const historyCandidates = movers
    .map((m: Record<string, string>) => ({
      symbol: String(m.ticker || "").toUpperCase(),
      price: num(m.price) ?? 0,
      volume: num(m.volume) ?? 0,
      changePct: num(String(m.change_percentage || "").replace("%", "")) ?? -Infinity,
      category: String(m.category || ""),
    }))
    .filter((m) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(m.symbol)
      && !/[./-](W|WS|WT|U|R|P)$/i.test(m.symbol)
      && !/\b(etf|warrant|preferred)\b/i.test(m.category)
      && m.price >= 5 && m.volume >= 1_000_000 && m.changePct > 0)
    .sort((a, b) => (b.price * b.volume) - (a.price * a.volume));
  const historySymbols = [...new Set([
    ...historyCandidates.slice(0, 11).map((m) => m.symbol),
    "SPY",
  ])].slice(0, 12);
  await upsertAssets([
    ...symbols.map((symbol) => ({ asset_type: "stock", symbol, name: symbol, provider_symbol: symbol, aliases: [], active: true })),
    { asset_type: "stock", symbol: "SPY", name: "SPDR S&P 500 ETF Trust", provider_symbol: "SPY", aliases: [], active: true },
  ]);
  const lookupSymbols = [...new Set([...symbols, "SPY", ...boardSymbols, ...historySymbols])];
  const assets = await db("asset_instruments?asset_type=eq.stock&symbol=in.(" + lookupSymbols.map(encodeURIComponent).join(",") + ")&select=id,symbol");
  const idBySymbol = new Map(assets.map((a: { id: string; symbol: string }) => [a.symbol, a.id]));
  const prices = movers.flatMap((m: Record<string, string>) => {
    const asset_id = idBySymbol.get(String(m.ticker).toUpperCase());
    const close = num(m.price);
    if (!asset_id || close === null) return [];
    return [{
      asset_id, source_id: source.id, market_date: today, observed_at: new Date().toISOString(), interval: "eod_mover_snapshot", currency: "USD", close,
      volume: num(m.volume), raw_metadata: { change: m.change, change_percentage: m.change_percentage, category: m.category },
    }];
  });
  await upsert("daily_prices", prices, "asset_id,source_id,market_date,interval");
  const history = includeHistory
    ? await ingestAlphaVantageHistory(source, historySymbols, idBySymbol, key)
    : { count: 0, symbols: [] as string[], failures: [] as string[] };
  return {
    count: prices.length,
    skipped: false,
    history_count: history.count,
    history_symbols: history.symbols,
    history_failures: history.failures,
  };
}

async function ingestFeed(source: Source) {
  const headers: Record<string, string> = { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" };
  if (source.source_key.startsWith("sec_")) {
    const userAgent = Deno.env.get("SEC_USER_AGENT");
    if (!userAgent || !/\S+@\S+/.test(userAgent)) throw new Error("SEC_USER_AGENT must identify the app and include a contact email");
    headers["User-Agent"] = userAgent;
  }
  const res = await request(source.feed_url, { headers });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const count = await insertArticles(source, parseFeed(await res.text()));
  return count;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ error: "POST required" }, 405);
  const expectedSecret = Deno.env.get("INGEST_SECRET");
  if (!supabaseUrl || !serviceKey || !expectedSecret) return response({ error: "collector secrets are not configured" }, 503);
  if (expectedSecret.length < 32) return response({ error: "INGEST_SECRET must contain at least 32 characters" }, 503);
  if (req.headers.get("x-market-pulse-secret") !== expectedSecret) return response({ error: "unauthorized" }, 401);

  let runId: string | null = null;
  const outcomes: Array<Record<string, unknown>> = [];
  try {
    const [created] = await db("ingestion_runs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "running" }) });
    runId = created.id;
    const sources: Source[] = await db("market_sources?enabled=eq.true&select=id,source_key,name,tier,trust_score,source_kind,access_method,feed_url,enabled,last_attempted_at,last_successful_at");
    let articleCount = 0;
    let priceCount = 0;
    let assetsCount = 0;
    let successCount = 0;
    for (const source of sources) {
      const today = new Date().toISOString().slice(0, 10);
      const lastAttemptDate = source.last_attempted_at?.slice(0, 10);
      const lastSuccessDate = source.last_successful_at?.slice(0, 10);
      const onceDaily = ["sec_company_tickers", "coinbase_public_crypto"].includes(source.source_key);
      if (onceDaily && lastSuccessDate === today) {
        outcomes.push({ source_key: source.source_key, status: "skipped", note: "daily collection already attempted/succeeded" });
        continue;
      }
      if (source.source_key === "alpha_vantage_us_movers" && !Deno.env.get("ALPHA_VANTAGE_API_KEY")) {
        outcomes.push({ source_key: source.source_key, status: "skipped", note: "ALPHA_VANTAGE_API_KEY not configured" });
        continue;
      }
      try {
        await patchSource(source.id, { last_attempted_at: new Date().toISOString(), last_error: null });
        if (source.source_key === "sec_company_tickers") {
          assetsCount += await ingestSecUniverse();
        } else if (source.source_key === "kraken_usd_markets") {
          const result = await ingestKraken(source, lastSuccessDate !== today);
          priceCount += Number(result.count);
          outcomes.push({ source_key: source.source_key, status: "succeeded", ...result });
        } else if (source.source_key === "coinbase_public_crypto") {
          const result = await ingestCoinbasePublicHistory(source);
          priceCount += Number(result.count);
          outcomes.push({ source_key: source.source_key, status: "succeeded", history_count: result.count, history_symbols: result.symbols, history_failures: result.failures });
        } else if (source.source_key === "alpha_vantage_us_movers") {
          // Refresh mover snapshots every collector cycle; spend the limited
          // daily-bar calls only on the first successful collection of the day.
          const result = await ingestAlphaVantage(source, lastSuccessDate !== today);
          priceCount += Number(result.count);
          outcomes.push({ source_key: source.source_key, status: result.skipped ? "skipped" : "succeeded", ...result });
        } else {
          articleCount += await ingestFeed(source);
        }
        if (!outcomes.some((o) => o.source_key === source.source_key && o.status === "skipped")) {
          successCount++;
          await patchSource(source.id, { last_successful_at: new Date().toISOString(), last_error: null });
        }
        if (!outcomes.some((o) => o.source_key === source.source_key)) outcomes.push({ source_key: source.source_key, status: "succeeded" });
      } catch (error) {
        const message = String(error).slice(0, 500);
        try { await patchSource(source.id, { last_error: message }); } catch { /* run details retain source errors */ }
        outcomes.push({ source_key: source.source_key, status: "failed", error: message });
      }
    }
    let forecastRefresh: Record<string, unknown> = { status: "not_attempted" };
    try {
      const rankingsUrl = new URL("/functions/v1/rankings", supabaseUrl).toString();
      const forecastResponse = await request(rankingsUrl, {
        headers: {
          "x-market-pulse-secret": expectedSecret,
          Accept: "application/json",
        },
      }, 25000);
      if (forecastResponse.ok) {
        const forecastPayload = await forecastResponse.json();
        forecastRefresh = {
          status: "succeeded",
          stocks: forecastPayload.tomorrow_forecast?.stocks?.length ?? 0,
          crypto: forecastPayload.tomorrow_forecast?.crypto?.length ?? 0,
          stock_target_date: forecastPayload.tomorrow_forecast?.stock_target_date ?? null,
          crypto_target_date: forecastPayload.tomorrow_forecast?.crypto_target_date ?? null,
        };
      } else {
        forecastRefresh = { status: "failed", http_status: forecastResponse.status };
      }
    } catch {
      forecastRefresh = { status: "failed", note: "ranking refresh unavailable; retry on next collector run" };
    }
    const failed = outcomes.filter((o) => o.status === "failed").length;
    const attempted = outcomes.filter((o) => o.status !== "skipped").length;
    await db(`ingestion_runs?id=eq.${runId}`, { method: "PATCH", body: JSON.stringify({
      finished_at: new Date().toISOString(), status: failed === 0 ? "succeeded" : successCount ? "partial" : "failed",
      sources_attempted: attempted, sources_succeeded: successCount, article_count: articleCount,
      price_count: priceCount, asset_count: assetsCount, error_count: failed, details: { outcomes, forecast_refresh: forecastRefresh },
    }) });
    return response({ run_id: runId, status: failed === 0 ? "succeeded" : successCount ? "partial" : "failed", outcomes, forecast_refresh: forecastRefresh });
  } catch (error) {
    if (runId) {
      try { await db(`ingestion_runs?id=eq.${runId}`, { method: "PATCH", body: JSON.stringify({ finished_at: new Date().toISOString(), status: "failed", error_count: 1, details: { fatal_error: String(error).slice(0, 500) } }) }); } catch { /* preserve the initial failure */ }
    }
    return response({ error: String(error).slice(0, 500), run_id: runId }, 500);
  }
});
