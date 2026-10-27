const state = { data: null, kind: "stock" };
const body = document.getElementById("rankings");
const errorBox = document.getElementById("error");
const refreshButton = document.getElementById("refresh");
const statusEl = document.getElementById("scan-status");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.01) return "$" + n.toFixed(6);
  if (Math.abs(n) < 1) return "$" + n.toFixed(4);
  if (Math.abs(n) < 1000) return "$" + n.toLocaleString("en-US", {maximumFractionDigits: 2});
  return "$" + n.toLocaleString("en-US", {maximumFractionDigits: 2});
}

function compactMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + Math.round(n);
}

function formatTime(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleString(undefined, {month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZoneName:"short"});
}

function formatDate(value) {
  if (!value) return "TODAY";
  const date = new Date(value + "T12:00:00Z");
  return date.toLocaleDateString(undefined, {weekday:"long", month:"long", day:"numeric", year:"numeric"}).toUpperCase();
}

function renderRows() {
  const rows = state.kind === "stock" ? (state.data?.stocks || []) : (state.data?.crypto || []);
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="loading-row">No qualifying signals are available for this market date yet.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => {
    const score = Math.max(0, Math.min(100, Number(row.score) || 0));
    const change = Number(row.change_pct) || 0;
    const news = Number(row.news_mentions) || 0;
    const symbol = escapeHtml(row.symbol);
    return `<tr>
      <td class="rank-cell">${String(row.rank).padStart(2,"0")}</td>
      <td><div class="asset-cell"><div class="asset-icon">${escapeHtml(symbol.slice(0,3))}</div><div class="asset-name"><strong>${symbol}</strong><span>${escapeHtml(row.name)}</span></div></div></td>
      <td class="price-cell">${money(row.last_price)}</td>
      <td class="change">+${change.toFixed(2)}%</td>
      <td class="turnover">${compactMoney(row.approx_usd_turnover)}</td>
      <td><div class="score-wrap"><span class="score-num">${score.toFixed(0)}</span><div class="score-track"><div class="score-fill" style="width:${score}%"></div></div></div></td>
      <td class="news-count">${news} linked</td>
    </tr>`;
  }).join("");
}

function applyData(data) {
  state.data = data;
  const stocks = data.stocks || [];
  const crypto = data.crypto || [];
  document.getElementById("market-date").textContent = formatDate(data.market_date);
  document.getElementById("scan-time").textContent = formatTime(data.generated_at);
  document.getElementById("stock-count").textContent = String(stocks.length).padStart(2,"0");
  document.getElementById("crypto-count").textContent = String(crypto.length).padStart(2,"0");
  document.getElementById("stock-tab-count").textContent = stocks.length;
  document.getElementById("crypto-tab-count").textContent = crypto.length;
  statusEl.innerHTML = '<span class="pulse-dot"></span> Scan ready';
  errorBox.hidden = true;
  renderRows();
}

async function loadData(showToast = false) {
  refreshButton.disabled = true;
  statusEl.innerHTML = '<span class="loader"></span> Refreshing';
  try {
    const response = await fetch("/api/rankings", {method:"GET", cache:"no-store", headers:{"Accept":"application/json"}});
    if (!response.ok) throw new Error("Dashboard data could not be loaded (" + response.status + ").");
    applyData(await response.json());
    if (showToast) {
      const toast = document.getElementById("toast");
      toast.textContent = "Latest rankings loaded.";
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 2200);
    }
  } catch (error) {
    errorBox.textContent = error.message || "Connection failed. Try refreshing.";
    errorBox.hidden = false;
    statusEl.textContent = "Connection needs attention";
    if (!state.data) body.innerHTML = '<tr><td colspan="7" class="loading-row">Could not reach Market Pulse. Check deployment configuration and try again.</td></tr>';
  } finally {
    refreshButton.disabled = false;
  }
}

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => {
    state.kind = button.dataset.kind;
    document.querySelectorAll(".tab").forEach(tab => {
      const active = tab === button;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    renderRows();
  });
});
refreshButton.addEventListener("click", () => loadData(true));
loadData();
