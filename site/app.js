// HazeRadar client. Renders the daily forecast produced by the pipeline; no computation on-device.
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const TZ = "Asia/Kuala_Lumpur";
const CAT_COLORS = { good: "var(--good)", moderate: "var(--moderate)", usg: "var(--usg)", unhealthy: "var(--unhealthy)", very_unhealthy: "var(--very_unhealthy)", hazardous: "var(--hazardous)" };
const catOf = (aqi) => aqi <= 50 ? ["good", "良好"] : aqi <= 100 ? ["moderate", "普通"] : aqi <= 150 ? ["usg", "敏感な人に不健康"]
  : aqi <= 200 ? ["unhealthy", "不健康"] : aqi <= 300 ? ["very_unhealthy", "非常に不健康"] : ["hazardous", "危険"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDay = (iso) => new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short", timeZone: "UTC" }).format(new Date(iso));
const fmtHour = (t) => new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", timeZone: TZ }).format(new Date(t * 1000));
const pct = (x) => `${Math.round(x * 100)}%`;
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

async function load() {
  try {
    const res = await fetch("data/forecast.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    render(await res.json());
  } catch (err) {
    $("headline").textContent = "予測データを読み込めませんでした";
    $("aqiCat").textContent = "オフライン";
    console.error(err);
  }
}

function render(f) {
  const d0 = f.daily[0];
  if (f.demo) {
    $("banner").hidden = false;
    $("banner").textContent = "これは合成データによるデモ表示です。GitHub Actions の初回実行後に実データへ置き換わります。";
  }
  $("loc").textContent = f.location.name;
  $("issued").textContent = `発表: ${new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: TZ }).format(new Date(f.generatedAt))} (MYT)`;

  // Hero
  drawGauge(d0.aqi.value, d0.aqi.key);
  $("aqiNum").textContent = d0.aqi.value;
  $("aqiCat").textContent = d0.aqi.category;
  $("aqiCat").style.color = CAT_COLORS[d0.aqi.key];
  $("aqiRange").textContent = `80%区間 AQI ${d0.aqiRange.low}–${d0.aqiRange.high}`;
  $("heroDate").textContent = `${fmtDay(d0.date)} の24時間平均予測 (US AQI)`;
  $("headline").textContent = f.narrative.headline;
  const kpi = (v, l) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
  $("kpis").innerHTML = [
    kpi(`${d0.pm25.p50}`, `PM2.5 µg/m³ (${d0.pm25.p10}–${d0.pm25.p90})`),
    kpi(pct(d0.pm25.probOver35), "AQI 100超の確率"),
    kpi(f.current?.pm25 ?? "–", "現在の PM2.5 解析値"),
    kpi(f.bestWindow ? f.bestWindow.from.replace(/^(今日|明日) /, "$1 ") : "–", "外出おすすめ開始"),
  ].join("");

  // AI briefing
  const n = f.narrative;
  $("aiSource").textContent = "予測モデルの要因分析から自動生成";
  $("summary").textContent = n.summary;
  const adv = (t, v) => `<div><b>${t}</b>${esc(v)}</div>`;
  $("advice").innerHTML = adv("一般の方", n.advice.general) + adv("敏感な方（子ども・高齢者・呼吸器/心疾患）", n.advice.sensitive)
    + adv("屋外に出るなら", n.advice.best_outdoor_window) + adv("窓・空気清浄機", n.advice.windows_and_purifier);
  $("confidence").textContent = n.confidence_comment;

  drawChart(f);
  renderDays(f);
  renderHaze(f);
  renderPollutants(d0);
  renderModel(f);
}

function drawGauge(aqi, key) {
  const g = $("gauge"); g.innerHTML = "";
  const R = 84, C = 2 * Math.PI * R, arc = 0.75;
  const base = el("circle", { cx: 100, cy: 100, r: R, fill: "none", stroke: "var(--bg2)", "stroke-width": 14, "stroke-linecap": "round",
    "stroke-dasharray": `${C * arc} ${C}`, transform: "rotate(135 100 100)" });
  const frac = Math.min(1, aqi / 300);
  const val = el("circle", { cx: 100, cy: 100, r: R, fill: "none", stroke: CAT_COLORS[key], "stroke-width": 14, "stroke-linecap": "round",
    "stroke-dasharray": `${C * arc * frac} ${C}`, transform: "rotate(135 100 100)" });
  g.append(base, val);
}

function drawChart(f) {
  const box = $("chart"); box.innerHTML = "";
  // Narrow screens get a taller aspect ratio so the chart stays legible.
  const W = Math.round(Math.max(520, Math.min(900, box.clientWidth * 1.4))), H = 300, m = { l: 36, r: 10, t: 10, b: 28 };
  const past = f.recent.filter((r) => r.pm25 != null);
  const hrs = f.hourly;
  const t0 = past[0]?.t ?? hrs[0].t, t1 = hrs.at(-1).t;
  const ymax = Math.max(40, ...hrs.map((h) => h.p90), ...past.map((p) => p.pm25)) * 1.08;
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / ymax) * (H - m.t - m.b);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "PM2.5 予測チャート" });

  const bands = [[0, 9, "good"], [9, 35.4, "moderate"], [35.4, 55.4, "usg"], [55.4, 125.4, "unhealthy"], [125.4, 225.4, "very_unhealthy"], [225.4, 1000, "hazardous"]];
  for (const [lo, hi, k] of bands) {
    if (lo >= ymax) continue;
    svg.append(el("rect", { x: m.l, width: W - m.l - m.r, y: y(Math.min(hi, ymax)), height: y(lo) - y(Math.min(hi, ymax)),
      fill: CAT_COLORS[k], opacity: 0.07 }));
  }
  // day separators (local midnight)
  for (let t = Math.ceil((t0 + 8 * 3600) / 86400) * 86400 - 8 * 3600; t < t1; t += 86400) {
    svg.append(el("line", { x1: x(t), x2: x(t), y1: m.t, y2: H - m.b, stroke: "var(--line)" }));
    const lab = el("text", { x: x(t) + 4, y: H - 10, fill: "var(--muted)", "font-size": 12 });
    lab.textContent = fmtDay(new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10));
    svg.append(lab);
  }
  for (let v = 0; v <= ymax; v += ymax > 120 ? 50 : ymax > 60 ? 20 : 10) {
    const tx = el("text", { x: m.l - 6, y: y(v) + 4, fill: "var(--muted)", "font-size": 11, "text-anchor": "end" });
    tx.textContent = v; svg.append(tx);
  }
  const path = (pts) => pts.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join("");
  const band = hrs.map((h) => [x(h.t), y(h.p90)]).concat(hrs.slice().reverse().map((h) => [x(h.t), y(h.p10)]));
  svg.append(el("path", { d: path(band) + "Z", fill: "var(--band)" }));
  svg.append(el("path", { d: path(hrs.filter((h) => h.cams != null).map((h) => [x(h.t), y(h.cams)])), fill: "none", stroke: "var(--cams)", "stroke-width": 1.5, "stroke-dasharray": "5 4" }));
  svg.append(el("path", { d: path(past.map((p) => [x(p.t), y(p.pm25)])), fill: "none", stroke: "var(--past)", "stroke-width": 2 }));
  svg.append(el("path", { d: path(hrs.map((h) => [x(h.t), y(h.p50)])), fill: "none", stroke: "var(--accent)", "stroke-width": 2.5 }));
  const nowX = x(f.current?.t ?? hrs[0].t);
  svg.append(el("line", { x1: nowX, x2: nowX, y1: m.t, y2: H - m.b, stroke: "var(--text)", "stroke-dasharray": "2 3", opacity: 0.5 }));
  const cursor = el("line", { y1: m.t, y2: H - m.b, stroke: "var(--text)", opacity: 0 });
  svg.append(cursor);
  box.append(svg);

  const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; box.append(tip);
  svg.addEventListener("pointermove", (ev) => {
    const r = svg.getBoundingClientRect();
    const t = t0 + ((ev.clientX - r.left) / r.width * W - m.l) / (W - m.l - m.r) * (t1 - t0);
    const h = hrs.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    const p = past.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), past[0]);
    const usePast = p && t <= (f.current?.t ?? 0);
    cursor.setAttribute("x1", x(usePast ? p.t : h.t)); cursor.setAttribute("x2", x(usePast ? p.t : h.t)); cursor.setAttribute("opacity", 0.3);
    tip.hidden = false;
    tip.innerHTML = usePast ? `${fmtHour(p.t)}<br>解析値 <b>${p.pm25}</b> µg/m³`
      : `${fmtHour(h.t)}<br>予測 <b>${h.p50}</b> µg/m³ (${h.p10}–${h.p90})<br>CAMS ${h.cams ?? "–"} ・ 風 ${h.wind} m/s ・ 雨 ${h.rain} mm`;
    const px = ev.clientX - r.left;
    tip.style.left = `${Math.min(px + 12, box.clientWidth - tip.offsetWidth - 4)}px`;
    tip.style.top = "8px";
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; cursor.setAttribute("opacity", 0); });
}

function renderDays(f) {
  const outlook = Object.fromEntries((f.narrative.outlook ?? []).map((o) => [o.date, o.comment]));
  $("days").innerHTML = f.daily.map((d) => {
    const c = CAT_COLORS[d.aqi.key];
    return `<article class="card day">
      <span class="d">${fmtDay(d.date)}${d.partial ? " <span class='muted small'>今日</span>" : ""}</span>
      <span class="badge"><i class="dot" style="background:${c}"></i>${d.aqi.value}</span>
      <span class="cat" style="color:${c}">${esc(d.aqi.category)}</span>
      <div class="row"><span>PM2.5</span><span>${d.pm25.p50} <small class="muted">(${d.pm25.p10}–${d.pm25.p90})</small></span></div>
      <div class="row"><span>AQI&gt;100 確率</span><span>${pct(d.pm25.probOver35)}</span></div>
      <div class="bar"><i style="width:${Math.max(3, d.pm25.probOver35 * 100)}%;background:var(--usg)"></i></div>
      <div class="row"><span>ヘイズ</span><span>${d.haze.riskLabel} (${d.haze.riskIndex})</span></div>
      <div class="row"><span>気流</span><span>${arrow(d.haze.flowFromDeg)} ${d.haze.flowFromDeg}°</span></div>
      <div class="row"><span>雨 / 風</span><span>${d.rainTotal}mm / ${d.windMean}m/s</span></div>
      <div class="row"><span>気温</span><span>${Math.round(d.tMin)}–${Math.round(d.tMax)}℃</span></div>
      ${outlook[d.date] ? `<p>${esc(outlook[d.date])}</p>` : ""}
    </article>`;
  }).join("");
}
// Arrow pointing where the air is going (from the origin towards Cyberjaya)
const arrow = (from) => `<span style="display:inline-block;transform:rotate(${(from + 180) % 360}deg)">↑</span>`;

function renderHaze(f) {
  const d0 = f.daily[0], h = d0.haze;
  $("season").textContent = f.season.ja;
  const svg = $("compass"); svg.innerHTML = "";
  svg.append(el("circle", { cx: 80, cy: 80, r: 66, fill: "none", stroke: "var(--line)", "stroke-width": 2 }));
  // SW haze sector 190–285°
  const pt = (deg, r) => [80 + r * Math.sin((deg * Math.PI) / 180), 80 - r * Math.cos((deg * Math.PI) / 180)];
  const [ax, ay] = pt(190, 66), [bx, by] = pt(285, 66);
  svg.append(el("path", { d: `M80,80 L${ax},${ay} A66,66 0 0,1 ${bx},${by} Z`, fill: "var(--usg)", opacity: 0.15 }));
  for (const [lab, deg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
    const [x, y] = pt(deg, 54);
    const t = el("text", { x, y: y + 4, "text-anchor": "middle", "font-size": 12, fill: "var(--muted)" }); t.textContent = lab; svg.append(t);
  }
  const [sx, sy] = pt(h.flowFromDeg, 62), [ex, ey] = pt(h.flowFromDeg, 8);
  svg.append(el("line", { x1: sx, y1: sy, x2: ex, y2: ey, stroke: "var(--accent)", "stroke-width": 4, "stroke-linecap": "round" }));
  const ang = ((h.flowFromDeg + 180) % 360) * Math.PI / 180;
  const hx = (a, r) => ex - r * Math.sin(ang + a), hy = (a, r) => ey + r * Math.cos(ang + a);
  svg.append(el("path", { d: `M${ex},${ey} L${hx(0.5, 12)},${hy(0.5, 12)} L${hx(-0.5, 12)},${hy(-0.5, 12)} Z`, fill: "var(--accent)" }));
  svg.append(el("circle", { cx: 80, cy: 80, r: 4, fill: "var(--text)" }));

  const fire = h.upwindFire ? `<div class="row"><span>風上の火災ホットスポット</span><span>${h.upwindFire.hotspotsUpwind}件 (指数 ${h.upwindFire.index})</span></div>` : "";
  const fires = f.fires ? `<div class="row"><span>48h 火災検知 (VIIRS)</span><span>スマトラ ${f.fires.byRegion.sumatra} / ボルネオ ${f.fires.byRegion.borneo}</span></div>` : "";
  $("hazeText").innerHTML = `
    <div class="row"><span>ヘイズリスク指数</span><span><b>${h.riskIndex}</b>/100 (${h.riskLabel})</span></div>
    <div class="bar"><i style="width:${h.riskIndex}%;background:${h.riskIndex >= 70 ? "var(--unhealthy)" : h.riskIndex >= 45 ? "var(--usg)" : "var(--moderate)"}"></i></div>
    <div class="row"><span>上空の気流の起源</span><span>${esc(h.origin.ja)}</span></div>
    <div class="row"><span>850hPa 風速</span><span>${h.flowSpeed850} m/s</span></div>
    <div class="row"><span>エアロゾル光学的厚さ</span><span>${h.aod ?? "–"}</span></div>
    ${fire}${fires}`;
  $("hazeComment").textContent = f.narrative.haze_comment;
}

function renderPollutants(d) {
  const items = [["PM2.5", "pm25", `${d.pm25.p50} µg/m³ (24h)`], ["PM10", "pm10", `${d.pm10} µg/m³ (24h)`],
    ["オゾン O₃", "o3", `${d.o3_8hmax} µg/m³ (8h最大)`], ["二酸化窒素 NO₂", "no2", `${d.no2_1hmax} µg/m³ (1h最大)`]];
  $("pollutants").innerHTML = items.map(([name, k, conc]) => {
    const v = d.aqi.sub[k] ?? 0, [ck] = catOf(v);
    return `<div class="pol"><div class="row"><span>${name}${d.aqi.dominant === k ? " ★" : ""}</span><span><b>${v}</b> <small class="muted">${conc}</small></span></div>
      <div class="bar"><i style="width:${Math.min(100, v / 2)}%;background:${CAT_COLORS[ck]}"></i></div></div>`;
  }).join("") + `<p class="small muted">★＝その日の AQI を決める主要汚染物質。UV 最大 ${d.uvMax}</p>`;
}

function renderModel(f) {
  const m = f.model;
  const colors = { cams: "var(--cams)", met: "var(--accent)", clim: "var(--past)" };
  $("weights").innerHTML = m.leadDayWeights.map((w) => `<div class="row"><span>${w.day}日目</span><span class="small">CAMS ${pct(w.weights.cams)} ・ 気象ML ${pct(w.weights.met)} ・ 持続 ${pct(w.weights.clim)}</span></div>
    <div class="stack">${Object.entries(w.weights).map(([k, v]) => `<i style="width:${v * 100}%;background:${colors[k]}"></i>`).join("")}</div>`).join("")
    + `<p class="small muted">気象ML は ${m.nwp.join(" / ")} で駆動。予測区間スケール ×${m.sigmaScale}${m.stationBiasLog ? `、観測バイアス補正 ${Math.round((Math.exp(m.stationBiasLog) - 1) * 100)}%` : ""}</p>`;
  $("drivers").innerHTML = m.drivers.map((d) => `<div class="row"><span>${esc(d.name)}</span><span style="color:${d.pctEffect > 0 ? "var(--usg)" : "var(--good)"}">${d.pctEffect > 0 ? "+" : ""}${d.pctEffect}%</span></div>`).join("")
    + `<p class="small muted">学習期間の平均と比べた PM2.5 への寄与（次の24時間）</p>`;
  $("skill").innerHTML = `<table><thead><tr><th>リード</th><th>気象ML</th><th>持続</th><th>改善率</th></tr></thead><tbody>${
    m.holdoutSkill.filter((s) => [1, 12, 24, 48, 72, 120].includes(s.lead)).map((s) => `<tr><td>${s.lead}h</td><td>${s.metRmse}</td><td>${s.persRmse}</td><td>${Math.round(s.skillVsPersistence * 100)}%</td></tr>`).join("")
  }</tbody></table><p class="small muted">log(PM2.5+1) の RMSE。改善率は持続予報に対する MSE スキルスコア。</p>`;
  const v = m.verification ?? {};
  const rows = Object.entries(v).map(([k, s]) => `<tr><td>${k.replace("day", "")}日目</td><td>${s.maeBlend}</td><td>${s.maeCams}</td><td>${s.maePersistence}</td><td>${pct(s.coverage80)}</td><td>${s.n}</td></tr>`).join("");
  $("verif").innerHTML = rows ? `<table><thead><tr><th>リード</th><th>本予測</th><th>CAMS</th><th>持続</th><th>80%区間的中</th><th>件数</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="small muted">日平均 PM2.5 の平均絶対誤差 (µg/m³)、直近30件。</p>` : `<p class="small muted">運用開始から数日で過去予測の答え合わせが始まります。</p>`;
}

// PWA plumbing
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
let deferred;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; $("install").hidden = false; });
$("install").addEventListener("click", async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $("install").hidden = true; });

load();
