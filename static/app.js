"use strict";

// ---------- helpers ----------
const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const DASH = "–";
const fmt = {
  pct: (x, d = 1, sign = false) => (x == null ? DASH : (sign && x > 0 ? "+" : "") + (x * 100).toFixed(d) + "%"),
  num: (x, d = 2) => (x == null ? DASH : Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })),
  signed: (x, d = 2) => (x == null ? DASH : (x > 0 ? "+" : "") + Number(x).toFixed(d)),
  date: (s) => (s ? new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : DASH),
  month: (s) => (s ? new Date(s + "T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : DASH),
};
const signCls = (x) => (x == null ? "" : x > 0 ? "pos" : x < 0 ? "neg" : "");
const CLASS_LABEL = { equity: "Equities", govt_bond: "Government bonds", credit: "Credit", commodity: "Commodities",
  real_estate: "Real estate", currency: "Currencies", cash: "Cash" };
const STATUS = { up: "Uptrend", down: "Downtrend", mixed: "Mixed", cash: "Cash" };
const REGION = { us: "United States", uk: "United Kingdom", intl_dm: "International developed", intl: "International ex-US",
  emerging: "Emerging markets", eurozone: "Euro area", south_korea: "South Korea", global: "Global" };
const regionName = (r) => REGION[r] || String(r || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const classColor = (c) => css(`--c-${c}`) || css("--neutral");

// Data source: the live API (uvicorn), or the pre-built files of the static site (app/export.py), which may be
// encrypted with a site password (AES-GCM, key derived with PBKDF2). The derived key never leaves the browser.
const STATIC = document.querySelector('meta[name="data-mode"]')?.content === "static";
const staticPath = (p) => "data/" + p.replace(/^\/api\//, "").replace(/^asset\//, "asset/") + ".json";
const KEY_STORE = "ms-site-key";
let siteKey = null;
class Locked extends Error {}

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const store = { get: (k) => { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v, remember) => { try { (remember ? localStorage : sessionStorage).setItem(k, v); } catch {} },
  clear: (k) => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} } };

async function importKey(raw) { return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["decrypt"]); }
async function decrypt(env) {
  if (!siteKey) {
    const saved = store.get(KEY_STORE);
    if (!saved) throw new Locked();
    siteKey = await importKey(b64(saved));
  }
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(env.iv) }, siteKey, b64(env.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    siteKey = null; store.clear(KEY_STORE);  // wrong or changed password
    throw new Locked();
  }
}
async function unlock(password, remember) {
  const lock = await (await fetch("data/lock.json", { cache: "no-store" })).json();
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: b64(lock.salt), iterations: lock.iter }, base, 256);
  siteKey = await importKey(bits);
  await decrypt(lock.check);  // throws Locked if the password is wrong
  store.set(KEY_STORE, btoa(String.fromCharCode(...new Uint8Array(bits))), remember);
}

const cache = new Map();
async function api(path) {
  if (!cache.has(path)) {
    const url = STATIC ? staticPath(path) : path;
    cache.set(path, fetch(url, STATIC ? { cache: "no-cache" } : {}).then((r) => {
      if (!r.ok) throw new Error(r.status === 404 ? "404 Not Found" : `${r.status} ${r.statusText}`);
      return r.json();
    }).then((d) => (d && d.enc === 1 ? decrypt(d) : d)).catch((e) => { cache.delete(path); throw e; }));
  }
  return cache.get(path);
}

function renderLock(failed) {
  app.innerHTML = `
    <form class="card lock" id="lock">
      <h1>Macro Signals</h1>
      <p class="muted">This dashboard is private. Enter the site password.</p>
      <input type="password" id="pw" autocomplete="current-password" placeholder="Password" required autofocus>
      <label class="small muted"><input type="checkbox" id="remember" checked> Remember on this device</label>
      ${failed ? '<p class="neg small">That password did not work.</p>' : ""}
      <button type="submit">Unlock</button>
    </form>`;
  document.getElementById("lock").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true; btn.textContent = "Unlocking…";
    try { await unlock(document.getElementById("pw").value, document.getElementById("remember").checked); cache.clear(); route(); }
    catch { renderLock(true); }
  });
}

// ---------- charts ----------
let charts = [];
function clearCharts() { charts.forEach((c) => c.remove()); charts = []; }
function chartsAvailable() { return typeof window.LightweightCharts !== "undefined"; }
function makeChart(el, opts = {}) {
  if (!chartsAvailable()) {
    el.innerHTML = '<div class="empty">Charts need the lightweight-charts library (loaded from unpkg). Check your connection.</div>';
    return null;
  }
  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: css("--muted"),
      fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 12 },
    grid: { vertLines: { visible: false }, horzLines: { color: css("--border") } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
    crosshair: { mode: 0 },
    handleScroll: false, handleScale: false,
    ...opts,
  });
  charts.push(chart);
  return chart;
}
const pctFormat = (d = 0) => ({ type: "custom", minMove: 0.0001, formatter: (v) => (v * 100).toFixed(d) + "%" });

function sparkline(points, color) {
  if (!points || points.length < 2) return "";
  const W = 300, H = 56, P = 2;
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { hi += 1; lo -= 1; }
  const x = (i) => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = (v) => P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(vals.length - 1).toFixed(1)},${H - P}L${x(0).toFixed(1)},${H - P}Z`;
  const zero = lo < 0 && hi > 0 ? `<line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="${css("--faint")}" stroke-dasharray="3 3" stroke-width="1"/>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" fill="${color}" opacity="0.10"/>${zero}
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------- shared bits ----------
function pill(status) {
  return `<span class="pill ${esc(status)}"><span class="dot"></span>${esc(STATUS[status] || status)}</span>`;
}
function distCell(x) {
  if (x == null) return DASH;
  const capped = Math.max(-0.3, Math.min(0.3, x));
  const w = (Math.abs(capped) / 0.3) * 50;
  const left = capped >= 0 ? 50 : 50 - w;
  const color = x >= 0 ? css("--up") : css("--down");
  return `<span class="dist"><span class="track"><span class="fill" style="left:${left}%;width:${w}%;background:${color}"></span></span>
    <span class="num ${signCls(x)}">${fmt.pct(x, 1, true)}</span></span>`;
}
function summaryCard(s) {
  if (!s || !s.text) return "";
  const src = s.source === "claude"
    ? `Written by Claude (${esc(s.model)}) from the numbers on this page; every figure checked against them`
    : "Template summary built from the numbers on this page";
  return `<section class="card summary-card">
      <p>${esc(s.text)}</p>
      <p class="muted small">${src} · describes the current state, not a forecast or advice.</p>
    </section>`;
}
function setActiveNav(route) {
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
}

// ---------- overview ----------
async function renderOverview() {
  const o = await api("/api/overview");
  document.getElementById("asof").textContent = `Prices to ${fmt.date(o.as_of)}`;
  const r = o.regime, m = o.model;
  const total = (o.breadth.up || 0) + (o.breadth.down || 0) + (o.breadth.mixed || 0);
  const acwi = o.benchmark[0];

  const flags = r.flags.map((f) => `
    <div class="flag">
      <span class="name">${esc(f.label)}</span>
      ${f.on == null ? '<span class="pill neutral">n/a</span>' : f.on ? '<span class="pill down"><span class="dot"></span>Stress</span>' : '<span class="pill up"><span class="dot"></span>Calm</span>'}
      <span class="detail">${esc(f.detail)}</span>
    </div>`).join("");

  const bar = m.weights.map((w) => `<span style="width:${(w.weight * 100).toFixed(2)}%;background:${classColor(w.asset_class)}" title="${esc(w.ticker)} ${fmt.pct(w.weight)}"></span>`).join("");
  const rows = m.weights.map((w) => `
    <div class="alloc-row">
      <span class="sw" style="background:${classColor(w.asset_class)}"></span>
      <a class="t" href="#/asset/${esc(w.id)}">${esc(w.ticker)}</a>
      <span class="nm">${esc(w.name)}</span>
      <span class="num">${fmt.pct(w.weight, 1)}</span>
    </div>`).join("");

  const groups = o.groups.map((g) => `
    <div class="class-block">
      <h3>${esc(g.label)}</h3>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Asset</th><th>Status</th><th class="n">vs 200-day avg</th><th class="n">12-1m momentum</th>
          <th class="n hide-sm">Volatility</th><th class="n hide-sm">Rank in class</th>
        </tr></thead>
        <tbody>${g.assets.map((a) => `
          <tr class="link" data-href="#/asset/${esc(a.id)}">
            <td><span class="ticker">${esc(a.ticker)}</span> <span class="nm hide-sm">${esc(a.name)}</span>${a.in_model ? `<span class="held" title="Held in the month-end model portfolio">${fmt.pct(a.model_weight, 1)}</span>` : ""}</td>
            <td>${pill(a.status)}</td>
            <td class="n">${a.status === "cash" ? DASH : distCell(a.vs_sma200)}</td>
            <td class="n ${signCls(a.mom_12_1)}">${fmt.pct(a.mom_12_1, 1, true)}</td>
            <td class="n hide-sm">${fmt.pct(a.vol, 1)}</td>
            <td class="n hide-sm">${a.class_rank ? `${a.class_rank} / ${a.class_size}` : DASH}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>`).join("");

  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Overview</h1>
        <p class="muted">Where each asset's trend stands today, the market's stress flags, and what the frozen model holds.</p>
      </div>
    </div>
    <div class="summary">
      <div class="kpi"><div class="label">Market regime</div>
        <div class="value" style="color:${r.risk_off ? css("--down") : css("--up")}">${r.risk_off ? "Risk-off" : "Risk-on"}</div>
        <div class="sub">${r.n_flags} of ${r.n_available} stress flags on</div></div>
      <div class="kpi"><div class="label">Assets in uptrend</div>
        <div class="value num">${o.breadth.up || 0}<span class="muted" style="font-size:15px;font-weight:500"> / ${total}</span></div>
        <div class="sub">${o.breadth.down || 0} in downtrend, ${o.breadth.mixed || 0} mixed</div></div>
      <div class="kpi"><div class="label">Global equities (ACWI)</div>
        <div class="value num ${signCls(acwi?.vs_sma200)}">${fmt.pct(acwi?.vs_sma200, 1, true)}</div>
        <div class="sub">vs 200-day average · ${esc(STATUS[acwi?.status] || "")}</div></div>
      <div class="kpi"><div class="label">VIX</div>
        <div class="value num">${fmt.num(r.vix, 1)}</div>
        <div class="sub">${r.vix >= 25 ? "Stressed (above 25)" : r.vix >= 18 ? "Elevated" : "Calm"}</div></div>
    </div>
    ${summaryCard(o.summary)}

    <div class="grid grid-2">
      <section class="card">
        <div class="card-head"><h2>Stress flags</h2><span class="regime-state ${r.risk_off ? "off" : "on"}">${r.risk_off ? "Risk-off" : "Risk-on"}</span></div>
        <div class="flags">${flags}</div>
        <p class="muted small" style="margin-top:12px">Risk-off when 2 or more flags are on. Shown as context: in backtests these flags did not improve on simple price trends. <a href="#/method">Why</a></p>
      </section>
      <section class="card">
        <div class="card-head"><h2>Model portfolio</h2>
          ${m.pre_freeze ? '<span class="pill neutral">Pre-freeze signal</span>' : '<span class="pill accent">Live</span>'}</div>
        <p class="muted small">${esc(m.id)} v${esc(m.version)} · month-end decision ${fmt.date(m.decision_date)}${m.pre_freeze ? ` · live record starts ${fmt.date(m.live_from)}` : ""}</p>
        <div class="alloc-bar">${bar}</div>
        <div class="alloc-list">${rows}</div>
        <p class="muted small" style="margin-top:12px">Rebalanced monthly, so a holding can slip below its trend mid-month. Fingerprint <span class="mono">${esc(m.fingerprint)}</span> ${m.fingerprint_ok ? "verified" : "<b class='neg'>MISMATCH</b>"} · ${m.live_decisions} live decisions · log ${m.chain_ok ? "intact" : "<b class='neg'>tampered</b>"}.</p>
      </section>
    </div>

    <section class="section">
      <div class="section-head">
        <h2>Trend board</h2>
        <span class="muted small">Uptrend = above the 200-day average and 12-month momentum beats cash (${fmt.pct(o.cash_mom_12_1, 1)}). Ranked within each class.</span>
      </div>
      ${groups}
    </section>`;

  app.querySelectorAll("tr.link").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    location.hash = tr.dataset.href;
  }));
}

// ---------- asset ----------
async function renderAsset(id) {
  const a = await api(`/api/asset/${encodeURIComponent(id)}`);
  const l = a.latest, mt = a.meta;
  app.innerHTML = `
    <a class="back" href="#/">← Overview</a>
    <div class="page-head">
      <div>
        <h1><span class="mono" style="font-size:20px">${esc(mt.ticker)}</span> · ${esc(mt.name)}</h1>
        <p class="muted">${esc(CLASS_LABEL[mt.asset_class] || mt.asset_class)} · ${esc(regionName(mt.region))}
          ${mt.role === "benchmark" ? " · benchmark (not held)" : ""}</p>
      </div>
      <div>${l.status ? pill(l.status) : ""} ${a.current_weight > 0 ? `<span class="pill accent">In model · ${fmt.pct(a.current_weight, 1)}</span>` : ""}</div>
    </div>
    <div class="chips">
      <div class="chip"><div class="label">Last close</div><div class="value num">${fmt.num(l.close, 2)}</div></div>
      <div class="chip"><div class="label">vs 200-day avg</div><div class="value num ${signCls(l.vs_sma200)}">${fmt.pct(l.vs_sma200, 1, true)}</div></div>
      <div class="chip"><div class="label">12-1m momentum</div><div class="value num ${signCls(l.mom_12_1)}">${fmt.pct(l.mom_12_1, 1, true)}</div></div>
      <div class="chip"><div class="label">6-1m momentum</div><div class="value num ${signCls(l.mom_6_1)}">${fmt.pct(l.mom_6_1, 1, true)}</div></div>
      <div class="chip"><div class="label">Volatility (3m, ann.)</div><div class="value num">${fmt.pct(l.vol, 1)}</div></div>
      <div class="chip"><div class="label">Rank in class</div><div class="value num">${l.class_rank ? `${l.class_rank} / ${l.class_size}` : DASH}</div></div>
    </div>
    ${summaryCard(a.summary)}
    ${a.call ? `<section class="card section-gap">
      <div class="card-head"><h2>Model call ${callPill(a.call.call)}</h2><a class="small" href="#/recommendations">All recommendations →</a></div>
      <p style="margin:0 0 6px">${esc(a.call.reason)}</p>
      <p class="muted small" style="margin:0">${esc(historyLine(a.call.history))}. Weight now ${fmt.pct(a.call.current_weight, 1, false)}, if today were the month-end ${fmt.pct(a.call.preview_weight, 1, false)}.</p>
    </section>` : ""}
    ${a.local_indices?.length ? `<section class="card section-gap">
      <div class="card-head"><h2>Headline indices</h2><span class="muted small">Local currency · price only · shown for reference, not used by the model</span></div>
      <div class="chips" style="margin-top:0">${a.local_indices.map((x) => `
        <div class="chip"><div class="label">${esc(x.name)}</div><div class="value num">${fmt.num(x.level, 0)}</div>
          <div class="label">${fmt.pct(x.vs_sma200, 1, true)} vs 200-day · ${fmt.pct(x.change_1y, 1, true)} 1 year</div></div>`).join("")}</div>
      <div class="legend">${a.local_indices.map((x, i) => `<span><i style="background:${css(`--series-${i + 1}`)}"></i>${esc(x.name)}</span>`).join("")}</div>
      <div class="chart short" id="c-local"></div>
      <p class="muted small">Last 5 years, rebased to 100. ${esc(mt.ticker)} is the fund the model can hold; its price is in USD and includes dividends, so it differs from these index levels.</p>
    </section>` : ""}
    ${a.current_weight > 0 && l.status !== "up" ? `<div class="notice"><span>ⓘ</span><span>Held since the last month-end rebalance, but its trend has
      weakened since. The model only re-checks at month-end; if it is still not in an uptrend then, its slot moves to cash.</span></div>` : ""}
    <section class="card">
      <div class="card-head"><h2>Price and 200-day average</h2><span class="muted small">Last 5 years · adjusted for dividends · to ${fmt.date(a.as_of)}</span></div>
      <div class="legend"><span><i style="background:${css("--series-1")}"></i>Price</span><span><i style="background:${css("--series-2")}"></i>200-day average</span></div>
      <div class="chart" id="c-price"></div>
    </section>
    <section class="card section">
      <div class="card-head"><h2>Weight in the model (backtest)</h2>
        <span class="muted small">Held in ${a.months_held} of ${a.months_total} months, ${fmt.month(a.weight_history[0]?.time)} – ${fmt.month(a.weight_history.at(-1)?.time)}</span></div>
      <div class="chart short" id="c-weight"></div>
    </section>`;

  const pc = makeChart(document.getElementById("c-price"), { handleScroll: true, handleScale: true });
  if (pc) {
    pc.addLineSeries({ color: css("--series-1"), lineWidth: 2, priceLineVisible: false }).setData(a.price);
    pc.addLineSeries({ color: css("--series-2"), lineWidth: 1.5, lineStyle: 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(a.sma200);
    pc.timeScale().fitContent();
  }
  const lcEl = document.getElementById("c-local");
  const lc = lcEl && makeChart(lcEl, { handleScroll: true, handleScale: true });
  if (lc) {
    a.local_indices.forEach((x, i) => lc.addLineSeries({ color: css(`--series-${i + 1}`), lineWidth: 1.6, priceLineVisible: false }).setData(x.rebased));
    lc.timeScale().fitContent();
  }
  const wc = makeChart(document.getElementById("c-weight"), { rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0 } } });
  if (wc) {
    wc.addHistogramSeries({ color: classColor(mt.asset_class), priceFormat: pctFormat(1), priceLineVisible: false }).setData(a.weight_history);
    wc.timeScale().fitContent();
  }
}

// ---------- recommendations ----------
const CALL_CLS = { Add: "up", Hold: "accent", Exit: "down", Watch: "mixed", Avoid: "neutral" };
const CALL_TEXT = {
  Add: "Not held now; would get a slot if today were the month-end.",
  Hold: "Held now and still qualifies.",
  Exit: "Held now, but would lose its slot if today were the month-end.",
  Watch: "Passes the trend filter but ranks below its class's slots.",
  Avoid: "Fails the trend filter; the model keeps it out.",
};
const callPill = (c) => `<span class="pill ${CALL_CLS[c]}"><span class="dot"></span>${esc(c)}</span>`;

function historyLine(h) {
  if (!h) return "";
  const part = (x, label) => x && x.months ? `${label}: avg next 3 months ${fmt.pct(x.fwd3_mean, 1, true)}, big loss in ${fmt.pct(x.loss3, 0)} of ${x.months} months` : `${label}: no history`;
  return `${part(h.passing, "When passing the filter")} · ${part(h.failing, "when failing")}`;
}

async function renderRecs() {
  const r = await api("/api/recommendations");
  const ev = r.evidence, st = ev.states;
  const supported = ev.effects.filter((e) => e.supported);
  const fmtDiff = (e) => (e.measure === "loss3" ? `${fmt.signed(e.diff * 100, 1)} pp` : `${fmt.pct(e.diff, 2, true)} / month`);

  const effects = ev.effects.map((e) => `
    <div class="flag">
      <span class="name">${esc(e.title)}</span>
      ${e.supported ? '<span class="pill up"><span class="dot"></span>Supported</span>' : '<span class="pill neutral">Not supported</span>'}
      <span class="detail">${esc(e.description)} Difference ${fmtDiff(e)}, t = ${fmt.num(e.t, 2)}, ${e.months} months.</span>
    </div>`).join("");

  const acts = r.actions.length ? r.actions.map((a) => `
    <div class="alloc-row">
      <span class="sw" style="background:${a.change > 0 ? css("--up") : css("--down")}"></span>
      <a class="t" href="#/asset/${esc(a.id)}">${esc(a.ticker)}</a>
      <span class="nm">${esc(a.name)}</span>
      <span class="num">${fmt.pct(a.from, 1, false)} → <b>${fmt.pct(a.to, 1, false)}</b></span>
    </div>`).join("") : '<p class="muted">No changes: the model would keep the same portfolio.</p>';

  const groups = ["Add", "Exit", "Hold", "Watch", "Avoid"].map((c) => {
    const xs = r.calls.filter((x) => x.call === c);
    if (!xs.length) return "";
    return `<div class="class-block">
      <h3>${callPill(c)} <span class="muted small" style="font-weight:400">${esc(CALL_TEXT[c])}</span></h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Asset</th><th>Why</th><th class="n hide-sm">Weight now → preview</th></tr></thead>
        <tbody>${xs.map((x) => `
          <tr class="link" data-href="#/asset/${esc(x.id)}">
            <td><span class="ticker">${esc(x.ticker)}</span> <span class="nm hide-sm">${esc(x.name)}</span>
              <div class="muted small">${esc(CLASS_LABEL[x.asset_class])}</div></td>
            <td class="why">${esc(x.reason)}<div class="muted small">${esc(historyLine(x.history))}</div></td>
            <td class="n hide-sm">${fmt.pct(x.current_weight, 1, false)} → ${fmt.pct(x.preview_weight, 1, false)}</td>
          </tr>`).join("")}</tbody>
      </table></div></div>`;
  }).join("");

  const stateRow = (k, label) => `<tr><td>${label}</td><td class="n">${st[k].n.toLocaleString("en-US")}</td>
    <td class="n ${signCls(st[k].fwd3_ex_mean)}">${fmt.pct(st[k].fwd3_ex_mean, 1, true)}</td><td class="n">${fmt.pct(st[k].fwd3_ex_median, 1, true)}</td>
    <td class="n">${fmt.pct(st[k].fwd3_pos, 0)}</td><td class="n">${fmt.pct(st[k].loss3, 1)}</td></tr>`;

  app.innerHTML = `
    <div class="page-head"><div>
      <h1>Recommendations</h1>
      <p class="muted">What the frozen model (${esc(r.model.id)} v${esc(r.model.version)}) would do if today, ${fmt.date(r.as_of)}, were the month-end.
        The next real decision is <b>${fmt.date(r.next_decision.T)}</b>, using data to ${fmt.date(r.next_decision.data_to)}. Only that logged decision counts.</p>
    </div></div>

    <div class="summary">
      ${["Add", "Hold", "Exit", "Watch"].map((c) => `<div class="kpi"><div class="label">${callPill(c)}</div><div class="value num">${r.counts[c] || 0}</div>
        <div class="sub">${esc(CALL_TEXT[c].split(";")[0])}</div></div>`).join("")}
    </div>

    <section class="card evidence-card">
      <div class="card-head"><h2>What the evidence supports</h2><span class="muted small">Backtest ${fmt.month(ev.start)} – ${fmt.month(ev.end)} · rules fixed in advance</span></div>
      <p class="lead">${supported.some((e) => e.key === "downside") && !supported.some((e) => e.key === "return")
        ? "These calls have reliably <b>reduced the chance of big losses</b>. They have <b>not</b> reliably picked assets with higher returns. Treat them as risk control, not as return forecasts."
        : `${supported.length} of ${ev.effects.length} effects are supported by the backtest. See each one below.`}</p>
      <div class="flags">${effects}</div>
      <p class="muted small" style="margin-top:12px">"Supported" means a Newey-West t-stat of at least ${fmt.num(ev.t_bar, 1)} in the expected direction over at least ${ev.min_months} months.
        "Big loss" means a fall of more than ${fmt.pct(-ev.loss_threshold, 0)} over the next 3 months.</p>
    </section>

    <div class="grid grid-2 section">
      <section class="card">
        <div class="card-head"><h2>Month-end changes (preview)</h2><span class="muted small">If ${fmt.date(r.next_decision.T)} were today</span></div>
        <div class="alloc-list">${acts}</div>
        <p class="muted small" style="margin-top:12px">Cash (T-bills): ${fmt.pct(r.cash_weight.current, 1, false)} now → ${fmt.pct(r.cash_weight.preview, 1, false)} in the preview.
          The final changes depend on prices up to ${fmt.date(r.next_decision.data_to)} and are logged automatically.</p>
      </section>
      <section class="card">
        <div class="card-head"><h2>What followed each call in the past</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>State at month-end</th><th class="n">Cases</th><th class="n">Avg next 3m vs cash</th><th class="n">Median</th><th class="n">Positive</th><th class="n">Big loss</th></tr></thead>
          <tbody>${stateRow("held", "Held (Hold/Add)")}${stateRow("watch", "Watch")}${stateRow("avoid", "Avoid")}</tbody>
        </table></div>
        <p class="muted small" style="margin-top:12px">All holdable assets in the backtest, one case per asset per month. Averages mix very different markets, so read the big-loss column first.</p>
      </section>
    </div>

    <section class="section">
      <div class="section-head"><h2>Every asset</h2><span class="muted small">Currencies and benchmarks are not traded by the model and are not listed.</span></div>
      ${groups}
    </section>
    <p class="muted small">This is the output of a rules-based research model, not personal investment advice. It does not know your situation, taxes or the funds available to you.</p>`;

  app.querySelectorAll("tr.link").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    location.hash = tr.dataset.href;
  }));
}

// ---------- track record ----------
const METRICS = [
  ["CAGR", "Annual return", (v) => fmt.pct(v, 1)], ["vol", "Volatility", (v) => fmt.pct(v, 1)],
  ["Sharpe", "Sharpe ratio", (v) => fmt.num(v, 2)], ["max_drawdown", "Max drawdown", (v) => fmt.pct(v, 1)],
  ["worst_12m", "Worst 12 months", (v) => fmt.pct(v, 1)], ["turnover_ann", "Turnover / year", (v) => fmt.pct(v, 0)],
  ["avg_cash", "Average cash", (v) => fmt.pct(v, 0)], ["cost_drag_ann", "Cost drag / year", (v) => fmt.pct(v, 2)],
];
const PERIODS = [["full", "Full period"], ["design", "2008–2019"], ["post2020", "2020–2026 (seen)"]];

async function renderTrack() {
  const t = await api("/api/track-record");
  const keys = ["model", "sixty_forty", "acwi"];
  const colors = { model: css("--series-1"), sixty_forty: css("--series-2"), acwi: css("--series-3") };
  const s = t.stats.full;
  const statsTable = (p) => `<table><thead><tr><th></th>${keys.map((k) => `<th class="n">${esc(t.names[k])}</th>`).join("")}</tr></thead>
    <tbody>${METRICS.map(([k, label, f]) => `<tr><td>${label}</td>${keys.map((n) => `<td class="n">${f(t.stats[p][n][k])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const live = t.live.length
    ? `<div class="table-wrap"><table><thead><tr><th>Decision</th><th>Logged</th><th>Holdings</th><th class="n">Model (net)</th><th class="n">60/40</th><th class="hide-sm">Hash</th></tr></thead><tbody>
        ${t.live.map((d) => `<tr><td>${fmt.date(d.T)}</td><td>${d.on_time ? '<span class="pill up">On time</span>' : '<span class="pill down">Late</span>'}</td>
          <td class="small">${Object.entries(d.weights).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${fmt.pct(v, 0)}`).join(", ")}</td>
          <td class="n ${signCls(d.realised_net)}">${d.realised_net == null ? "pending" : fmt.pct(d.realised_net, 2, true)}</td>
          <td class="n ${signCls(d.sixty_forty)}">${d.sixty_forty == null ? "pending" : fmt.pct(d.sixty_forty, 2, true)}</td>
          <td class="mono hide-sm">${esc(d.row_hash)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">No live decisions yet. The first is due on <b>${fmt.date(t.live_from)}</b>. Each one is logged before trading,
       hash-chained to the previous entry, and cannot be edited afterwards.</div>`;

  app.innerHTML = `
    <div class="page-head"><div><h1>Track record</h1>
      <p class="muted">Simulated backtest from ${fmt.month(t.first_year_from)} to ${fmt.month(t.last_month)}, net of ${t.costs_bps} bps trading costs, in USD, monthly rebalancing.</p></div></div>
    <div class="notice"><span>⚠</span><span><strong>A backtest is not evidence of future returns.</strong> The rules were fixed before testing,
      but none of the 10 variants tested showed a statistically significant edge over 60/40. The model's demonstrated value is smaller drawdowns, not higher returns.
      The live record below, starting ${fmt.date(t.live_from)}, is the real test.</span></div>
    <div class="summary">
      <div class="kpi"><div class="label">Annual return</div><div class="value num">${fmt.pct(s.model.CAGR, 1)}</div><div class="sub">60/40: ${fmt.pct(s.sixty_forty.CAGR, 1)} · ACWI: ${fmt.pct(s.acwi.CAGR, 1)}</div></div>
      <div class="kpi"><div class="label">Sharpe ratio</div><div class="value num">${fmt.num(s.model.Sharpe, 2)}</div><div class="sub">60/40: ${fmt.num(s.sixty_forty.Sharpe, 2)} · ACWI: ${fmt.num(s.acwi.Sharpe, 2)}</div></div>
      <div class="kpi"><div class="label">Max drawdown</div><div class="value num neg">${fmt.pct(s.model.max_drawdown, 1)}</div><div class="sub">60/40: ${fmt.pct(s.sixty_forty.max_drawdown, 1)} · ACWI: ${fmt.pct(s.acwi.max_drawdown, 1)}</div></div>
      <div class="kpi"><div class="label">Worst 12 months</div><div class="value num neg">${fmt.pct(s.model.worst_12m, 1)}</div><div class="sub">60/40: ${fmt.pct(s.sixty_forty.worst_12m, 1)} · ACWI: ${fmt.pct(s.acwi.worst_12m, 1)}</div></div>
    </div>
    <section class="card">
      <div class="card-head"><h2>Growth of $1</h2><span class="muted small">Log scale</span></div>
      <div class="legend">${keys.map((k) => `<span><i style="background:${colors[k]}"></i>${esc(t.names[k])}</span>`).join("")}</div>
      <div class="chart" id="c-eq"></div>
    </section>
    <section class="card section">
      <div class="card-head"><h2>Drawdown from previous peak</h2></div>
      <div class="chart short" id="c-dd"></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Statistics</h2><div class="tabs" id="period-tabs">${PERIODS.map(([k, l], i) => `<button data-p="${k}" class="${i ? "" : "active"}">${l}</button>`).join("")}</div></div>
      <div class="table-wrap" id="stats-table">${statsTable("full")}</div>
      <p class="muted small" style="margin-top:8px">2020–2026 was examined while the model was being chosen, so it is not a clean out-of-sample test.</p>
    </section>

    <section class="section">
      <div class="section-head"><h2>Every 60/40 drawdown deeper than 8%</h2><span class="muted small">Return from the 60/40 peak to its trough</span></div>
      <div class="table-wrap"><table><thead><tr><th>Episode</th>${keys.map((k) => `<th class="n">${esc(t.names[k])}</th>`).join("")}</tr></thead>
        <tbody>${t.episodes.map((e) => `<tr><td>${fmt.month(e.start)} – ${fmt.month(e.trough)}</td>${keys.map((k) => `<td class="n ${signCls(e.returns[k])}">${fmt.pct(e.returns[k], 1, true)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Calendar years</h2><span class="muted small">First and last years are partial</span></div>
      <div class="table-wrap"><table><thead><tr><th>Year</th>${keys.map((k) => `<th class="n">${esc(t.names[k])}</th>`).join("")}</tr></thead>
        <tbody>${t.yearly.slice().reverse().map((y) => `<tr><td>${y.year}</td>${keys.map((k) => `<td class="n ${signCls(y[k])}">${fmt.pct(y[k], 1, true)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Live record</h2><span class="muted small">Log ${t.chain_ok ? "verified intact" : "<b class='neg'>failed verification</b>"}</span></div>
      ${live}
    </section>`;

  document.getElementById("period-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    document.querySelectorAll("#period-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.getElementById("stats-table").innerHTML = statsTable(b.dataset.p);
  });

  const eq = makeChart(document.getElementById("c-eq"), { rightPriceScale: { borderVisible: false, mode: 1 } });
  if (eq) {
    keys.slice().reverse().forEach((k) => eq.addLineSeries({ color: colors[k], lineWidth: k === "model" ? 2.5 : 1.5,
      priceLineVisible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 } }).setData(t.equity[k]));
    eq.timeScale().fitContent();
  }
  const dd = makeChart(document.getElementById("c-dd"));
  if (dd) {
    keys.slice().reverse().forEach((k) => dd.addLineSeries({ color: colors[k], lineWidth: k === "model" ? 2 : 1.3,
      priceLineVisible: false, lastValueVisible: false, priceFormat: pctFormat(0) }).setData(t.drawdown[k]));
    dd.timeScale().fitContent();
  }
}

// ---------- macro ----------
async function renderMacro() {
  const m = await api("/api/macro");
  const card = (c) => `
    <div class="card macro-card">
      <div class="small muted">${esc(c.label)}</div>
      <div style="margin-top:4px"><span class="v num">${fmt.num(c.value, Math.abs(c.value) >= 100 ? 0 : 2)}</span><span class="unit">${esc(c.unit)}</span></div>
      <div class="meta"><span>${c.freq === "D" ? "as of" : "period"} ${c.freq === "M" ? fmt.month(c.period) : fmt.date(c.period)}</span>
        <span class="num ${""}">1y: ${fmt.signed(c.change_1y, Math.abs(c.value) >= 100 ? 0 : 2)}</span></div>
      ${sparkline(c.history, css("--series-1"))}
      <div class="note">${esc(c.note)}${c.note ? " " : ""}<span class="faint">${c.vintage ? "As first published (vintage data)." : c.lag_days ? `Assumed ${c.lag_days}-day publication lag.` : ""}</span></div>
    </div>`;
  app.innerHTML = `
    <div class="page-head"><div><h1>Macro context</h1>
      <p class="muted">What the economy and policy backdrop look like, as known today. Ten-year history, monthly.</p></div></div>
    <div class="notice"><span>ⓘ</span><span><strong>Context, not signals.</strong> In pre-registered tests, adding these macro indicators to
      market-trend rules did not improve results. They help explain what is happening, not predict what happens next.</span></div>
    <div class="macro-grid">${m.cards.map(card).join("")}</div>`;
}

// ---------- method ----------
function renderMethod() {
  app.innerHTML = `
    <div class="page-head"><div><h1>Method</h1><p class="muted">What the model does, what the evidence says, and how the record is protected.</p></div></div>
    <div class="prose">
      <h2>The model</h2>
      <p>At each month-end the model ranks ETFs <b>within</b> five asset classes (equities, government bonds, credit, commodities, real estate)
      on 12- and 6-month momentum and distance to the 200-day average, all scaled by volatility. It fills fixed slots per class
      (equities 4 × 12.5%, government bonds 2 × 10%, credit 1 × 10%, commodities 2 × 7.5%, real estate 1 × 5%).
      An asset only gets its slot if it is above its 200-day average and its 12-month return beats cash. Otherwise the slot goes to T-bills.</p>

      <h2>What the evidence says</h2>
      <ul>
        <li><b>Picking winners did not work.</b> The ranking's correlation with next month's returns was about 0.02, which is statistically indistinguishable from zero.</li>
        <li><b>The trend filter cut losses in every major drawdown:</b> 2008–09, 2011, 2020 and 2022. The worst loss was −12% vs −34% for 60/40. The price is missed rebounds (2009, 2016, 2023).</li>
        <li><b>Macro indicators added nothing beyond price trends</b> when timing a 60/40 portfolio. They are shown as context only.</li>
        <li><b>No variant beat its baseline with statistical significance.</b> Ten variants were fixed in advance and tested with a block bootstrap and a Bonferroni correction.</li>
      </ul>

      <h2>How the record is protected</h2>
      <ul>
        <li>The model is <b>frozen</b>: a SHA-256 fingerprint covers its configuration and code. The live job refuses to run if anything changed.</li>
        <li>Each month-end decision is logged <b>before</b> trading, from data up to the previous day, and marked late if it is not.</li>
        <li>The log is <b>append-only</b> (database triggers) and <b>hash-chained</b>, so any later edit is detectable.</li>
        <li>Macro data is <b>point-in-time</b>: revised series use the values as first published (ALFRED vintages). No series is used before it existed.</li>
      </ul>

      <h2>Limitations</h2>
      <ul>
        <li>All returns are in USD with US-listed ETFs. A euro investor's experience differs because of currency moves and UCITS fund availability.</li>
        <li>Prices come from Yahoo Finance (unofficial). A licensed source is needed before any public use.</li>
        <li>The backtest covers 2008–2026, which is only four major drawdowns. The researcher knew this history, so even pre-registered rules carry some hindsight.</li>
      </ul>

      <h2>Not investment advice</h2>
      <p>This is a research prototype. It does not take your circumstances into account and is not a recommendation to buy or sell anything.</p>
    </div>`;
}

// ---------- router ----------
async function route() {
  clearCharts();
  const h = location.hash.replace(/^#/, "") || "/";
  const [, page, arg] = h.split("/");
  const name = page || "overview";
  setActiveNav(name === "asset" ? "overview" : name);
  app.innerHTML = '<div class="loading">Loading…</div>';
  try {
    if (name === "overview") await renderOverview();
    else if (name === "asset") await renderAsset(decodeURIComponent(arg || ""));
    else if (name === "recommendations") await renderRecs();
    else if (name === "track-record") await renderTrack();
    else if (name === "macro") await renderMacro();
    else if (name === "method") renderMethod();
    else app.innerHTML = '<div class="error">Page not found. <a href="#/">Go to the overview</a></div>';
    if (!document.getElementById("asof").textContent) api("/api/health").then((x) => (document.getElementById("asof").textContent = `Prices to ${fmt.date(x.as_of)}`)).catch(() => {});
    window.scrollTo(0, 0);
  } catch (e) {
    if (e instanceof Locked) return renderLock(false);
    app.innerHTML = `<div class="error">Could not load data (${esc(e.message)}). ${STATIC ? "Try reloading the page." : "Is the server running?"}</div>`;
  }
}
window.addEventListener("hashchange", route);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", route);
route();
