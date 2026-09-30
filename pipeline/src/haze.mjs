// Transboundary haze diagnostics: monsoon flow, air-mass origin, upwind fire load.
import { SITE } from "./config.mjs";

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;

function bearingDist(lat, lon) {
  const p1 = rad(SITE.lat), p2 = rad(lat), dl = rad(lon - SITE.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const brg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return { brg, km: 2 * R * Math.asin(Math.sqrt(a)) };
}

// Direction the wind is blowing FROM, in degrees.
export const fromDir = (u, v) => ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;

export function originLabel(deg) {
  if (deg >= 190 && deg < 285) return { key: "sumatra", ja: "スマトラ島方面（南西）" };
  if (deg >= 285 && deg < 335) return { key: "malacca", ja: "マラッカ海峡・北スマトラ方面（西北西）" };
  if (deg >= 335 || deg < 30) return { key: "north", ja: "半島北部・タイ南部方面（北）" };
  if (deg >= 30 && deg < 110) return { key: "scs", ja: "南シナ海方面（東〜北東）" };
  return { key: "south", ja: "シンガポール・リアウ諸島方面（南〜南東）" };
}

export function monsoonPhase(month) {
  if (month >= 6 && month <= 9) return { key: "sw", ja: "南西モンスーン期（ヘイズ警戒シーズン）", hazeSeason: 1 };
  if (month === 10 || month === 5) return { key: "inter", ja: "モンスーン間期（スコール多め、残存ヘイズに注意）", hazeSeason: 0.7 };
  return { key: "ne", ja: "北東モンスーン期（雨季、ヘイズは少ない）", hazeSeason: 0.3 };
}

export function upwindFireLoad(fires, upwindDeg) {
  if (!fires) return null;
  let load = 0, n = 0;
  for (const f of fires) {
    const { brg, km } = bearingDist(f.lat, f.lon);
    let diff = Math.abs(brg - upwindDeg); if (diff > 180) diff = 360 - diff;
    if (diff > 60 || km > 2000) continue;
    load += f.frp * Math.exp(-km / 700) * Math.cos(rad(diff)) ** 2;
    n++;
  }
  return { load, hotspotsUpwind: n, index: Math.min(100, Math.round((Math.log1p(load) / Math.log1p(3000)) * 100)) };
}

export function fireSummary(fires) {
  if (!fires) return null;
  // The Strait of Malacca is approximated by the line (100.3E,4.5N)–(103.4E,1.3N).
  const region = (f) => {
    if (f.lon >= 108.5) return "borneo";
    const peninsula = f.lon > 99.5 && f.lon < 104.6 && f.lat < 7 && f.lat > 4.5 - (f.lon - 100.3) * 1.032;
    if (peninsula) return "peninsula";
    if (f.lat < 6 && f.lon < 106.5) return "sumatra";
    return "other";
  };
  const c = { sumatra: 0, borneo: 0, peninsula: 0, other: 0 };
  for (const f of fires) c[region(f)]++;
  return { total: fires.length, byRegion: c };
}

export function dailyHaze({ dayHours, month, fires }) {
  const u = dayHours.reduce((s, h) => s + h.u850, 0) / dayHours.length;
  const v = dayHours.reduce((s, h) => s + h.v850, 0) / dayHours.length;
  const deg = fromDir(u, v);
  const swFrac = dayHours.filter((h) => { const d = fromDir(h.u850, h.v850); return d >= 190 && d < 300; }).length / dayHours.length;
  const rain = dayHours.reduce((s, h) => s + (h.rain ?? 0), 0);
  const aod = dayHours.map((h) => h.aod).filter((x) => x != null);
  const aodMean = aod.length ? aod.reduce((a, b) => a + b, 0) / aod.length : null;
  const phase = monsoonPhase(month);
  const fire = upwindFireLoad(fires, deg);
  const smoke = fire ? fire.index / 100 : Math.min(1, (aodMean ?? 0.3) / 0.8);
  const dryness = 1 - Math.min(rain / 15, 1);
  const risk = Math.round(100 * Math.min(1, phase.hazeSeason * (0.35 * swFrac + 0.25 * dryness + 0.4 * smoke) * 1.25));
  return {
    flowFromDeg: Math.round(deg), flowSpeed850: +Math.hypot(u, v).toFixed(1), origin: originLabel(deg),
    swFraction: +swFrac.toFixed(2), rainTotal: +rain.toFixed(1), aod: aodMean != null ? +aodMean.toFixed(2) : null,
    upwindFire: fire, riskIndex: risk,
    riskLabel: risk >= 70 ? "高" : risk >= 45 ? "中" : risk >= 25 ? "低〜中" : "低",
  };
}
