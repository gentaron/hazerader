// Data acquisition: CAMS air quality (Open-Meteo), multi-model NWP (Open-Meteo),
// optional ground station (WAQI) and optional satellite fire hotspots (NASA FIRMS).
import fs from "node:fs/promises";
import path from "node:path";
import { SITE, NWP_MODELS, PAST_DAYS, FORECAST_DAYS } from "./config.mjs";

const MOCK_DIR = process.env.HZ_MOCK_DIR;

async function getJSON(url, fixture, { retries = 3 } = {}) {
  if (MOCK_DIR) return JSON.parse(await fs.readFile(path.join(MOCK_DIR, `${fixture}.json`), "utf8"));
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "hazerader/1.0" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.split("?")[0]}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
  throw lastErr;
}

async function getText(url, fixture) {
  if (MOCK_DIR) {
    try { return await fs.readFile(path.join(MOCK_DIR, `${fixture}.csv`), "utf8"); } catch { return null; }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url.split("?")[0]}`);
  return res.text();
}

export const AQ_VARS = [
  "pm2_5", "pm10", "ozone", "nitrogen_dioxide", "sulphur_dioxide",
  "carbon_monoxide", "aerosol_optical_depth", "dust", "uv_index",
];

export async function fetchAirQuality() {
  const q = new URLSearchParams({
    latitude: SITE.lat, longitude: SITE.lon,
    hourly: AQ_VARS.join(","),
    past_days: PAST_DAYS, forecast_days: FORECAST_DAYS,
    domains: "cams_global", timezone: "GMT", timeformat: "unixtime",
  });
  const j = await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`, "air_quality");
  return { time: j.hourly.time, ...Object.fromEntries(AQ_VARS.map((v) => [v, j.hourly[v] ?? []])) };
}

export const MET_VARS = [
  "temperature_2m", "relative_humidity_2m", "precipitation", "wind_speed_10m",
  "wind_direction_10m", "boundary_layer_height", "wind_speed_850hPa", "wind_direction_850hPa",
  "cloud_cover",
];

// Returns { time, models: { [model]: { var: number[] } } } — models whose data is entirely missing are dropped.
export async function fetchWeather() {
  const q = new URLSearchParams({
    latitude: SITE.lat, longitude: SITE.lon,
    hourly: MET_VARS.join(","), models: NWP_MODELS.join(","),
    past_days: PAST_DAYS, forecast_days: FORECAST_DAYS + 1,
    wind_speed_unit: "ms", timezone: "GMT", timeformat: "unixtime",
  });
  const j = await getJSON(`https://api.open-meteo.com/v1/forecast?${q}`, "weather");
  const models = {};
  for (const m of NWP_MODELS) {
    const vars = {};
    for (const v of MET_VARS) {
      const arr = j.hourly[`${v}_${m}`] ?? (NWP_MODELS.length === 1 ? j.hourly[v] : undefined);
      if (arr && arr.some((x) => x != null)) vars[v] = arr;
    }
    if (vars.wind_speed_10m && vars.relative_humidity_2m) models[m] = vars;
  }
  return { time: j.hourly.time, models };
}

// Optional: nearest DOE station via the World Air Quality Index project (needs WAQI_TOKEN).
export async function fetchStation() {
  const token = process.env.WAQI_TOKEN;
  if (!token && !MOCK_DIR) return null;
  try {
    const j = await getJSON(`https://api.waqi.info/feed/geo:${SITE.lat};${SITE.lon}/?token=${token}`, "waqi", { retries: 1 });
    if (j.status !== "ok") return null;
    const d = j.data;
    return {
      station: d.city?.name ?? "unknown",
      stationGeo: d.city?.geo ?? null,
      time: d.time?.iso ? Math.floor(Date.parse(d.time.iso) / 1000) : null, // UTC unix seconds
      pm25Aqi: d.iaqi?.pm25?.v ?? null,
      pm10Aqi: d.iaqi?.pm10?.v ?? null,
      aqi: typeof d.aqi === "number" ? d.aqi : null,
    };
  } catch (err) {
    console.warn("[station] unavailable:", err.message);
    return null;
  }
}

// Optional: VIIRS fire hotspots over Sumatra / Peninsular Malaysia / Borneo (needs FIRMS_MAP_KEY).
export async function fetchFires() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key && !MOCK_DIR) return null;
  try {
    const csv = await getText(
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/95,-6,120,8/2`, "firms");
    if (!csv) return null;
    const [header, ...rows] = csv.trim().split(/\r?\n/);
    const cols = header.split(",");
    const iLat = cols.indexOf("latitude"), iLon = cols.indexOf("longitude"),
      iFrp = cols.indexOf("frp"), iConf = cols.indexOf("confidence");
    return rows.map((r) => r.split(",")).filter((c) => c.length === cols.length && c[iConf] !== "l")
      .map((c) => ({ lat: +c[iLat], lon: +c[iLon], frp: +c[iFrp] || 1 }));
  } catch (err) {
    console.warn("[fires] unavailable:", err.message);
    return null;
  }
}
