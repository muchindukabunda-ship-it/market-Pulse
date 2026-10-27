const state = { data: null, kind: "stock", chartKind: "stock", forecastKind: "stock" };
const body = document.getElementById("rankings");
const errorBox = document.getElementById("error");
const refreshButton = document.getElementById("refresh");
const statusEl = document.getElementById("scan-status");
const colors = ["#78edc1","#43b998","#438e91","#2c5559","#a6c56d"];
function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));}
function number(value){const n=Number(value);return Number.isFinite(n)?n:0;}
function money(value){const n=number(value);if(Math.abs(n)<0.01&&n!==0)return "$"+n.toFixed(6);if(Math.abs(n)<1&&n!==0)return "$"+n.toFixed(4);return "$"+n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}
function compactMoney(value){const n=number(value);if(n>=1e12)return "$"+(n/1e12).toFixed(2)+"T";if(n>=1e9)return "$"+(n/1e9).toFixed(2)+"B";if(n>=1e6)return "$"+(n/1e6).toFixed(1)+"M";if(n>=1e3)return "$"+(n/1e3).toFixed(1)+"K";return "$"+Math.round(n);}
function formatTime(value){if(!value)return "Not available";const d=new Date(value);return Number.isNaN(d.getTime())?"Not available":d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"});}
function formatDate(value){if(!value)return "TODAY";const d=new Date(value+"T12:00:00Z");return d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric",year:"numeric"}).toUpperCase();}
function currentRows(kind){return kind==="stock"?(state.data?.stocks||[]):(state.data?.crypto||[]);}
function averageScore(rows){return rows.length?rows.reduce((a,r)=>a+number(r.score),0)/rows.length:0;}
function gaugeLabel(score){if(score>=75)return "High relative signal";if(score>=50)return "Moderate relative signal";if(score>0)return "Lower relative signal";return "No signal data";}
function setGauge(score){const clipped=Math.max(0,Math.min(100,score));document.getElementById("gauge-number").textContent=clipped.toFixed(0);document.getElementById("gauge-ring").style.strokeDashoffset=String(452.4*(1-clipped/100));document.getElementById("gauge-label").textContent=gaugeLabel(clipped);document.getElementById("gauge-description").textContent="Average score across "+(state.data?.stocks?.length||0)+" stocks and "+(state.data?.crypto?.length||0)+" coins in today’s board. A relative model score—not odds of a gain.";}
function renderSummary(){const stocks=state.data?.stocks||[],coins=state.data?.crypto||[],all=[...stocks,...coins];document.getElementById("stock-count").textContent=String(stocks.length).padStart(2,"0");document.getElementById("crypto-count").textContent=String(coins.length).padStart(2,"0");document.getElementById("side-stock-count").textContent=stocks.length;document.getElementById("side-crypto-count").textContent=coins.length;document.getElementById("stock-tab-count").textContent=stocks.length;document.getElementById("crypto-tab-count").textContent=coins.length;document.getElementById("avg-score").textContent=all.length?averageScore(all).toFixed(0):"—";document.getElementById("board-turnover").textContent=compactMoney(all.reduce((sum,r)=>sum+number(r.approx_usd_turnover),0));document.getElementById("market-date").textContent=formatDate(state.data?.market_date);document.getElementById("scan-time").textContent=formatTime(state.data?.generated_at);setGauge(averageScore(all));statusEl.innerHTML='<i class="live-dot"></i> Scan ready';}
function miniGauge(score){const s=Math.max(0,Math.min(100,score)),circ=56.55;return '<div class="mini-gauge" role="img" aria-label="Signal score '+s.toFixed(0)+' out of 100"><svg viewBox="0 0 24 24" aria-hidden="true"><circle class="track" cx="12" cy="12" r="9"></circle><circle class="value" cx="12" cy="12" r="9" stroke-dasharray="'+circ+'" stroke-dashoffset="'+(circ*(1-s/100))+'"></circle></svg><span>'+s.toFixed(0)+'</span></div>';}
function historyCell(row){
 const points=Array.isArray(row.history)?row.history.filter(p=>Number.isFinite(Number(p.close))):[];
 if(points.length<2)return '<div class="history-cell empty"><span>Collecting history</span></div>';
 const shown=points.length>60?points.filter((_,i)=>i%Math.ceil(points.length/60)===0||i===points.length-1):points;
 const values=shown.map(p=>Number(p.close)),min=Math.min(...values),max=Math.max(...values),span=max-min||1;
 const coords=values.map((v,i)=>({x:2+i*(92/Math.max(1,values.length-1)),y:27-((v-min)/span)*22}));
 const path=coords.map((p,i)=>(i?"L":"M")+p.x.toFixed(1)+" "+p.y.toFixed(1)).join(" ");
 const pct=number(row.history_return_pct),positive=pct>=0;
 const title=points[0].date+" to "+points[points.length-1].date+" · "+points.length+" daily bars";
 return '<div class="history-cell" title="'+escapeHtml(title)+'"><svg viewBox="0 0 96 32" role="img" aria-label="'+escapeHtml(title)+' price trend"><path d="'+path+'" class="'+(positive?"up":"down")+'" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg><span class="'+(positive?"up":"down")+'">'+(positive?"+":"")+pct.toFixed(1)+'%</span></div>';
}
function entryReference(row){
 const points=Array.isArray(row.history)?row.history.filter(p=>Number.isFinite(Number(p.close))&&Number(p.close)>0):[];
 if(points.length>=20){const recent=points.slice(-20);return {price:recent.reduce((sum,p)=>sum+Number(p.close),0)/recent.length,method:"20-day SMA"};}
 return {price:number(row.last_price),method:"last snapshot · history limited"};
}
function quoteFor(row){return state.data?.live_quotes?.[row.symbol]||{};}
function priceCell(price,label,title="",live=false){
 const display=Number.isFinite(Number(price))&&Number(price)>0?money(price):"—";
 return '<td class="table-pricepair" title="'+escapeHtml(title)+'"><strong>'+display+'</strong><small class="'+(live?"price-live":"price-stale")+'">'+escapeHtml(label)+'</small></td>';
}
function dayAverageCell(row){
 const quote=quoteFor(row),avg=Number(quote.day_average);
 if(!Number.isFinite(avg)||avg<=0)return '<td class="table-pricepair" title="No intraday average is available for this asset."><strong>—</strong><small class="price-stale">not available</small></td>';
 return priceCell(avg,"5m VWAP est.",quote.source+" · "+(quote.bars_today||0)+" bars today");
}
function currentPriceCell(row){
 const quote=quoteFor(row),live=quote.live===true&&Number(quote.current_price)>0;
 const value=live?quote.current_price:row.last_price;
 const label=live?"LIVE · "+(quote.quote_mode||"feed"):"LAST REFRESHED";
 return priceCell(value,label,(quote.source||"ranking snapshot")+" · "+formatTime(quote.quote_time||quote.refreshed_at||row.observed_at),live);
}
function renderRows(){const rows=currentRows(state.kind);document.getElementById("board-title").textContent=state.kind==="stock"?"Equity signals":"Digital asset signals";if(!rows.length){body.innerHTML='<tr><td colspan="8" class="loading-row">No qualifying signals are available for this market date yet.</td></tr>';renderAllocation();return;}body.innerHTML=rows.map(row=>{const score=Math.max(0,Math.min(100,number(row.score))),change=number(row.change_pct),symbol=escapeHtml(row.symbol),changeClass=change<0?"table-change negative":"table-change",entry=entryReference(row);return '<tr><td><div class="asset-id"><span class="rank-mini">'+String(row.rank).padStart(2,"0")+'</span><span class="coin-mark">'+escapeHtml(symbol.slice(0,3))+'</span><span class="asset-label"><strong>'+symbol+'</strong><span>'+escapeHtml(row.name)+'</span></span></div></td>'+priceCell(entry.price,entry.method,"Calculated reference; experimental and not backtested")+dayAverageCell(row)+currentPriceCell(row)+'<td class="table-history">'+historyCell(row)+'</td><td class="'+changeClass+'">'+(change>0?"+":"")+change.toFixed(2)+'%</td><td class="table-turnover">'+compactMoney(row.approx_usd_turnover)+'</td><td><div class="table-signal">'+miniGauge(score)+'<span class="signal-word">'+(score>=75?"STRONG":score>=50?"MID":"LOW")+'</span></div></td></tr>';}).join("");renderAllocation();}
function renderForecast(){
 const forecast=state.data?.tomorrow_forecast;
 const list=document.getElementById("forecast-rows");
 const date=state.forecastKind==="stock"?forecast?.stock_target_date:forecast?.crypto_target_date;
 document.getElementById("forecast-date").textContent=date?formatDate(date):"Awaiting forecast";
 const record=forecast?.track_record?.[state.forecastKind]||{};
 document.getElementById("forecast-win-rate").textContent=record.positive_return_pct!==null&&record.positive_return_pct!==undefined&&Number.isFinite(Number(record.positive_return_pct))?Number(record.positive_return_pct).toFixed(0)+"%":"—";
 document.getElementById("forecast-avg-return").textContent=record.average_return_pct!==null&&record.average_return_pct!==undefined&&Number.isFinite(Number(record.average_return_pct))?(Number(record.average_return_pct)>0?"+":"")+Number(record.average_return_pct).toFixed(2)+"%":"—";
 document.getElementById("forecast-evaluated").textContent=String(record.evaluated||0);
 document.querySelectorAll(".forecast-tab").forEach(tab=>{const active=tab.dataset.forecastKind===state.forecastKind;tab.classList.toggle("active",active);tab.setAttribute("aria-selected",String(active));});
 const rows=forecast?.[state.forecastKind==="stock"?"stocks":"crypto"]||[];
 if(!rows.length){list.innerHTML='<tr><td colspan="4" class="loading-row">No saved forecast is available yet. Refresh the dashboard to generate one from the latest collector snapshot.</td></tr>';document.getElementById("forecast-source").textContent="Forecast unavailable; today’s board remains separate.";return;}
 list.innerHTML=rows.map(row=>{const returned=row.result_return_pct===null||row.result_return_pct===undefined?null:Number(row.result_return_pct),result=returned===null?'<span class="forecast-pending">Pending close</span>':'<span class="'+(returned>=0?"up":"down")+'">'+(returned>0?"+":"")+returned.toFixed(2)+'% · next close</span>';return '<tr><td><div class="asset-id"><span class="rank-mini">'+String(row.rank).padStart(2,"0")+'</span><span class="coin-mark">'+escapeHtml(String(row.symbol||"").slice(0,3))+'</span><span class="asset-label"><strong>'+escapeHtml(row.symbol)+'</strong><span>'+escapeHtml(row.name)+'</span></span></div></td><td class="table-turnover">'+money(row.snapshot_price)+'</td><td>'+miniGauge(number(row.score))+'</td><td>'+result+'</td></tr>';}).join("");
 document.getElementById("forecast-source").textContent="Saved "+formatTime(forecast.forecasted_at)+" · "+(forecast.method||"momentum-liquidity-v1")+" · "+rows.length+" qualifying candidate"+(rows.length===1?"":"s");
}
function setForecastKind(kind){state.forecastKind=kind;renderForecast();}
function renderMovement(){const rows=[...currentRows(state.chartKind)].sort((a,b)=>number(b.change_pct)-number(a.change_pct)).slice(0,5);const chart=document.getElementById("move-chart");if(!rows.length){chart.innerHTML='<div class="allocation-empty">No movement snapshot available.</div>';return;}const max=Math.max(1,...rows.map(r=>Math.abs(number(r.change_pct))));chart.innerHTML=rows.map(r=>{const v=number(r.change_pct),width=Math.max(2,Math.abs(v)/max*46),neg=v<0;return '<div class="move-row"><span class="move-symbol">'+escapeHtml(r.symbol)+'</span><div class="move-track"><span class="move-bar '+(neg?"negative":"")+'" style="width:'+width+'%"></span></div><span class="move-value '+(neg?"negative":"")+'">'+(v>0?"+":"")+v.toFixed(2)+'%</span></div>';}).join("");}
function renderAllocation(){const budget=Math.max(0,number(document.getElementById("budget").value)),exposure=number(document.getElementById("exposure").value),rows=currentRows(state.kind).slice(0,5),model=budget*exposure/100,reserve=budget-model,each=rows.length?model/rows.length:0;document.getElementById("exposure-label").textContent=exposure.toFixed(0)+"%";document.getElementById("model-amount").textContent=money(model);document.getElementById("reserve-amount").textContent=money(reserve);const chart=document.getElementById("allocation-donut");const used=rows.length?exposure:0;const hue=rows.map((r,i)=>colors[i%colors.length]+" "+(i*used/rows.length)+"% "+((i+1)*used/rows.length)+"%");if(used<100)hue.push("#344447 "+used+"% 100%");chart.style.background="conic-gradient("+ (hue.length?hue.join(","):"#344447 0% 100%")+ ")";chart.innerHTML='<span>'+(rows.length?rows.length+" assets":"—")+'<small>EQUAL SPLIT</small></span>';const out=document.getElementById("allocation-rows");if(!rows.length){out.innerHTML='<div class="allocation-empty">Load a market board to model a split.</div>';return;}out.innerHTML=rows.map((r,i)=>'<div class="allocation-row"><div class="allocation-asset"><i class="allocation-color" style="background:'+colors[i%colors.length]+'"></i><div>'+escapeHtml(r.symbol)+'<small>Rank '+String(r.rank).padStart(2,"0")+' · score '+number(r.score).toFixed(0)+'</small></div></div><div class="allocation-amount">'+money(each)+'<small>'+(exposure/rows.length).toFixed(1)+'% of scenario</small></div></div>').join("");}
function applyData(data){state.data=data;errorBox.hidden=true;renderSummary();renderRows();renderMovement();renderForecast();}
async function refreshLiveQuotes(){
 if(!state.data)return;
 const symbols=(state.data.crypto||[]).map(row=>row.symbol).filter(Boolean).slice(0,10);
 if(!symbols.length)return;
 try{
  const response=await fetch("/api/live-prices?symbols="+encodeURIComponent(symbols.join(",")),{method:"GET",cache:"no-store",headers:{"Accept":"application/json"}});
  if(!response.ok)throw new Error("live price feed unavailable");
  const payload=await response.json();
  state.data.live_quotes=payload.quotes||{};
  state.data.live_refreshed_at=payload.refreshed_at||new Date().toISOString();
  renderRows();
  statusEl.innerHTML='<i class="live-dot"></i> Quotes updated '+escapeHtml(formatTime(state.data.live_refreshed_at));
 }catch{
  state.data.live_quotes=state.data.live_quotes||{};
  statusEl.innerHTML='<i class="live-dot"></i> Using last refreshed prices';
 }
}
async function loadData(showToast=false){refreshButton.disabled=true;statusEl.innerHTML='<span class="live-dot"></span> Refreshing feed';try{const response=await fetch("/api/rankings",{method:"GET",cache:"no-store",headers:{"Accept":"application/json"}});if(!response.ok)throw new Error("Dashboard data could not be loaded ("+response.status+").");applyData(await response.json());await refreshLiveQuotes();if(showToast){const toast=document.getElementById("toast");toast.textContent="Market board and available live prices refreshed.";toast.classList.add("show");setTimeout(()=>toast.classList.remove("show"),2200);}}catch(error){errorBox.textContent=error.message||"Connection failed. Try refreshing.";errorBox.hidden=false;statusEl.textContent="Feed needs attention";if(!state.data)body.innerHTML='<tr><td colspan="8" class="loading-row">Could not reach Market Pulse. Check the protected data endpoint and try again.</td></tr>';}finally{refreshButton.disabled=false;}}
function setMarket(kind){state.kind=kind;document.querySelectorAll(".market-tab").forEach(tab=>{const active=tab.dataset.kind===kind;tab.classList.toggle("active",active);tab.setAttribute("aria-selected",String(active));});document.querySelectorAll(".side-nav [data-kind]").forEach(btn=>btn.classList.toggle("active",btn.dataset.kind===kind));renderRows();}
document.querySelectorAll(".market-tab").forEach(tab=>tab.addEventListener("click",()=>setMarket(tab.dataset.kind)));
document.querySelectorAll(".side-nav [data-kind]").forEach(btn=>btn.addEventListener("click",()=>setMarket(btn.dataset.kind)));

document.querySelectorAll(".forecast-tab").forEach(tab=>tab.addEventListener("click",()=>setForecastKind(tab.dataset.forecastKind)));
document.getElementById("chart-kind").addEventListener("change",event=>{state.chartKind=event.target.value;renderMovement();});
document.getElementById("budget").addEventListener("input",renderAllocation);
document.getElementById("exposure").addEventListener("input",event=>{const v=number(event.target.value);event.target.style.background="linear-gradient(90deg,#66e4b1 "+v+"%,#314447 "+v+"%)";renderAllocation();});
refreshButton.addEventListener("click",()=>loadData(true));
loadData();setInterval(()=>refreshLiveQuotes(),60000);