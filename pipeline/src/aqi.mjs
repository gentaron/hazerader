// US EPA AQI (2024 PM2.5 revision). Concentrations in µg/m³ unless noted.
const BP = {
  // [Clow, Chigh, Ilow, Ihigh]
  pm25_24h: [[0, 9.0, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150], [55.5, 125.4, 151, 200],
    [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500]],
  pm10_24h: [[0, 54, 0, 50], [55, 154, 51, 100], [155, 254, 101, 150], [255, 354, 151, 200],
    [355, 424, 201, 300], [425, 604, 301, 500]],
  o3_8h_ppb: [[0, 54, 0, 50], [55, 70, 51, 100], [71, 85, 101, 150], [86, 105, 151, 200], [106, 200, 201, 300]],
  no2_1h_ppb: [[0, 53, 0, 50], [54, 100, 51, 100], [101, 360, 101, 150], [361, 649, 151, 200],
    [650, 1249, 201, 300], [1250, 2049, 301, 500]],
};
// Legacy (pre-2024) PM2.5 table used by WAQI station feeds, for inverting their index.
const LEGACY_PM25 = [[0, 12, 0, 50], [12.1, 35.4, 51, 100], [35.5, 55.4, 101, 150], [55.5, 150.4, 151, 200],
  [150.5, 250.4, 201, 300], [250.5, 500.4, 301, 500]];

const DEC = { pm25_24h: 1, pm10_24h: 0, o3_8h_ppb: 0, no2_1h_ppb: 0 };

export function subIndex(kind, c) {
  if (c == null || !Number.isFinite(c)) return null;
  const table = BP[kind];
  const f = 10 ** DEC[kind];
  const x = Math.max(0, Math.floor(c * f) / f);
  for (const [cl, ch, il, ih] of table) {
    if (x <= ch) return Math.round(((ih - il) / (ch - cl)) * (Math.max(x, cl) - cl) + il);
  }
  const [cl, ch, il, ih] = table.at(-1);
  return Math.min(500, Math.round(((ih - il) / (ch - cl)) * (x - cl) + il));
}

export function legacyPm25AqiToConc(aqi) {
  if (aqi == null) return null;
  for (const [cl, ch, il, ih] of LEGACY_PM25) {
    if (aqi <= ih) return cl + ((aqi - il) * (ch - cl)) / (ih - il);
  }
  return 500;
}

export const ugToPpb = { o3: (x) => x / 1.96, no2: (x) => x / 1.88 };

export const CATEGORIES = [
  { max: 50, key: "good", ja: "良好", color: "#00e400" },
  { max: 100, key: "moderate", ja: "普通", color: "#ffff00" },
  { max: 150, key: "usg", ja: "敏感な人に不健康", color: "#ff7e00" },
  { max: 200, key: "unhealthy", ja: "不健康", color: "#ff0000" },
  { max: 300, key: "very_unhealthy", ja: "非常に不健康", color: "#8f3f97" },
  { max: 500, key: "hazardous", ja: "危険", color: "#7e0023" },
];
export const category = (aqi) => CATEGORIES.find((c) => aqi <= c.max) ?? CATEGORIES.at(-1);
