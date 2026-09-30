// Daily briefing writer. Fully local and free: turns the numerical forecast (ML ensemble,
// driver attribution, haze diagnostics, verification record) into a Japanese explanation.
const DRIVER_TEXT = {
  "直近24h PM2.5水準": ["ここ24時間の汚れた空気が残りやすい", "ここ24時間の空気がきれいだった流れが続く"],
  "PM2.5トレンド": ["濃度が上昇傾向にある", "濃度が下降傾向にある"],
  "大気の換気能 (混合層高×風速)": ["空気がこもりやすい（混合層が低い・風が弱い）", "よく混ざって拡散しやすい（混合層が高い・風がある）"],
  "6時間降水量": ["雨が少なく洗い流されにくい", "雨で粒子が洗い流される"],
  "相対湿度": ["湿度で粒子が成長しやすい", "湿度が低めで粒子が成長しにくい"],
  "気温": ["気温条件が汚染側に働く", "気温条件がきれいな側に働く"],
};
const dirText = (name, effect) => {
  const t = DRIVER_TEXT[name];
  if (t) return effect > 0 ? t[0] : t[1];
  if (/850hPa|地上風/.test(name)) return effect > 0 ? "風向きが汚れた空気を運びやすい" : "風向きがきれいな空気を運んでくる";
  return effect > 0 ? `${name}が悪化要因` : `${name}が改善要因`;
};
const pct = (p) => Math.round(p * 100);
const fmtDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${"日月火水木金土"[d.getUTCDay()]})`;
};

function trendWord(a, b) {
  const r = b / Math.max(a, 1);
  return r > 1.25 ? "悪化" : r > 1.08 ? "やや悪化" : r < 0.8 ? "改善" : r < 0.93 ? "やや改善" : "横ばい";
}

function confidence(d) {
  const width = d.pm25.p90 / Math.max(d.pm25.p10, 1);
  return width < 1.5 ? "高" : width < 2.2 ? "中" : "低";
}

export async function writeNarrative(s) {
  const [d0, d1] = s.daily;
  const cat = (d) => `${d.aqi.category}（AQI ${d.aqi.value}）`;
  const top = s.drivers.filter((d) => Math.abs(d.pctEffect) >= 3).slice(0, 3);
  const up = top.filter((d) => d.effect > 0), down = top.filter((d) => d.effect < 0);

  // Headline
  let headline;
  if (d0.aqi.value > 150) headline = `今日は${cat(d0)}。屋外活動は控えて`;
  else if (d0.aqi.value > 100) headline = `今日は${cat(d0)}。敏感な人は要注意`;
  else if (d1 && d1.aqi.value > 100 && d0.aqi.value <= 100) headline = `今日は${d0.aqi.category}、明日は悪化の恐れ`;
  else if (d0.haze.riskIndex >= 70) headline = `今日は${d0.aqi.category}。ただしヘイズ警戒`;
  else headline = `今日は${cat(d0)}の見込み`;

  // Summary with reasons
  const reasons = [
    up.length ? `悪化要因は「${[...new Set(up.map((d) => dirText(d.name, d.effect)))].join("」「")}」` : null,
    down.length ? `改善要因は「${[...new Set(down.map((d) => dirText(d.name, d.effect)))].join("」「")}」` : null,
  ].filter(Boolean).join("、");
  let summary = `今日のPM2.5 24時間平均は約${d0.pm25.p50}µg/m³（80%の確率で${d0.pm25.p10}〜${d0.pm25.p90}）で${d0.aqi.category}。`;
  if (d1) summary += `明日は${trendWord(d0.pm25.p50, d1.pm25.p50)}して${cat(d1)}、AQI 100を超える確率は${pct(d1.pm25.probOver35)}%。`;
  if (reasons) summary += `${reasons}。`;
  if (d0.haze.riskIndex >= 45) summary += `上空の気流は${d0.haze.origin.ja}から来ていて、ヘイズリスクは${d0.haze.riskLabel}。`;

  // Day-by-day outlook
  const outlook = s.daily.map((d, i) => {
    const parts = [`${cat(d)}、PM2.5 ${d.pm25.p50}µg/m³`];
    if (i > 0) parts.push(`前日比${trendWord(s.daily[i - 1].pm25.p50, d.pm25.p50)}`);
    if (d.pm25.probOver35 >= 0.3) parts.push(`AQI 100超の確率${pct(d.pm25.probOver35)}%`);
    if (d.rainTotal >= 10) parts.push(`まとまった雨（${d.rainTotal}mm）で洗浄効果`);
    else if (d.rainTotal < 1) parts.push("雨がほぼなく汚染が溜まりやすい");
    if (d.haze.riskIndex >= 45) parts.push(`ヘイズ${d.haze.riskLabel}（気流は${d.haze.origin.ja}）`);
    parts.push(`信頼度${confidence(d)}`);
    return { date: d.date, comment: `${parts.join("。")}。` };
  });

  // Health advice (US EPA guidance, simplified)
  const a = d0.aqi.value;
  const general = a <= 50 ? "空気はきれいです。屋外の運動もどうぞ。"
    : a <= 100 ? "ほとんどの人は普段どおりで問題ありません。"
      : a <= 150 ? "普段どおりで大丈夫ですが、長時間の激しい運動は短めに。"
        : a <= 200 ? "長時間・激しい屋外運動は控えましょう。外出時は N95/KN95 マスクを。"
          : "屋外活動は最小限に。外出時は N95/KN95 マスクを必ず。";
  const sensitive = a <= 50 ? "特別な配慮は不要です。"
    : a <= 100 ? "とても敏感な人は、咳や息苦しさが出たら屋外運動を軽めに。"
      : a <= 150 ? "子ども・高齢者・喘息や心疾患のある人は、長時間の屋外運動を控えめに。吸入薬は手元に。"
        : "子ども・高齢者・喘息や心疾患のある人は屋内で過ごしましょう。";
  const best = s.bestWindow
    ? `${s.bestWindow.from}〜${s.bestWindow.to}頃がいちばんきれい（PM2.5 約${s.bestWindow.pm25}µg/m³）。朝の通勤時間帯は汚れやすい傾向です。`
    : "時間帯による差は小さい見込みです。";
  const windows = a > 150 ? "窓は閉めて、空気清浄機を強で運転。エアコンは内気循環に。"
    : a > 100 ? "窓は閉めめにして、空気清浄機を運転しましょう。"
      : "換気して大丈夫。空気がきれいな時間帯に窓を開けるのがおすすめ。";

  // Haze comment
  const fire = d0.haze.upwindFire
    ? `風上の火災ホットスポットは${d0.haze.upwindFire.hotspotsUpwind}件（指数${d0.haze.upwindFire.index}）。`
    : "";
  const hazeComment = `現在は${s.season.ja}。今日のヘイズリスク指数は${d0.haze.riskIndex}/100（${d0.haze.riskLabel}）で、`
    + `上空（850hPa）の気流は${d0.haze.origin.ja}から吹いています。${fire}`
    + (d0.haze.origin.key === "sumatra" && s.season.hazeSeason >= 0.7
      ? "スマトラ方面からの風はこの時期、森林火災の煙を運びやすいので、急な悪化に注意。"
      : "越境ヘイズが入りやすい気流ではありません。");

  // Confidence comment from verification record
  const v = s.verification?.day1;
  let conf = `今日の予測の信頼度は${confidence(d0)}、明日は${d1 ? confidence(d1) : "–"}。`;
  if (v && v.n >= 3) {
    const better = v.maeBlend < v.maeCams;
    conf += `直近${v.n}回の翌日予測の平均誤差は${v.maeBlend}µg/m³（CAMS単体 ${v.maeCams}、持続予報 ${v.maePersistence}）`
      + `${better ? "で、CAMS単体より高精度です。" : "。"}`;
  } else {
    conf += "毎日の答え合わせが数日たまると、精度の実績もここに表示されます。";
  }

  return {
    source: "local",
    headline, summary, outlook,
    advice: { general, sensitive, best_outdoor_window: best, windows_and_purifier: windows },
    haze_comment: hazeComment,
    confidence_comment: conf,
  };
}
