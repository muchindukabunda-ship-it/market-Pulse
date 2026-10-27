module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const upstreamUrl = process.env.MPULSE_RANKINGS_URL;
  const secret = process.env.MPULSE_READ_SECRET;
  if (!upstreamUrl || !secret) {
    return res.status(503).json({ error: "Market Pulse data connection is not configured" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "x-market-pulse-secret": secret,
        "Accept": "application/json"
      }
    });
    if (!upstream.ok) {
      return res.status(upstream.status === 401 ? 502 : upstream.status).json({ error: "Market Pulse data source returned an error" });
    }
    const data = await upstream.json();
    return res.status(200).json(data);
  } catch {
    return res.status(502).json({ error: "Market Pulse data source could not be reached" });
  } finally {
    clearTimeout(timer);
  }
};
