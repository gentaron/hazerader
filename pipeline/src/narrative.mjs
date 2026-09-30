// Daily AI briefing: Claude reads the numerical forecast and writes the Japanese analysis.
// Falls back to a deterministic template when ANTHROPIC_API_KEY is not configured.
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL } from "./config.mjs";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "outlook", "advice", "haze_comment", "confidence_comment"],
  properties: {
    headline: { type: "string", description: "今日の一言（40字以内）" },
    summary: { type: "string", description: "今日〜明日の見通しと理由（200字程度）" },
    outlook: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["date", "comment"],
        properties: { date: { type: "string" }, comment: { type: "string" } },
      },
    },
    advice: {
      type: "object", additionalProperties: false,
      required: ["general", "sensitive", "best_outdoor_window", "windows_and_purifier"],
      properties: {
        general: { type: "string" }, sensitive: { type: "string" },
        best_outdoor_window: { type: "string" }, windows_and_purifier: { type: "string" },
      },
    },
    haze_comment: { type: "string" },
    confidence_comment: { type: "string" },
  },
};

const SYSTEM = `あなたはマレーシア・クランバレーの大気質予報官です。サイバージャヤ (Mutiara Ville) の住民向けに、
数値予測パイプラインの出力 (JSON) を読み、日本語で簡潔かつ具体的な解説を書きます。

ルール:
- 数値は入力 JSON にあるものだけを使い、推測で新しい数値を作らない。AQI は US EPA (2024) 基準。
- 予測の不確実性 (p10–p90、確率、アンサンブルの不一致、検証成績) を正直に伝える。
- 越境ヘイズ (スマトラ/ボルネオの森林火災)、南西モンスーン、夕方のスコール、朝の逆転層と交通による日内変動など、
  現地の気象メカニズムに即して「なぜそうなるか」を説明する。
- 健康アドバイスは、一般の人と敏感な人 (子ども、高齢者、喘息・心疾患のある人) を分けて実用的に。
- 誇張も過小評価もしない。`;

export async function writeNarrative(summary) {
  if (!process.env.ANTHROPIC_API_KEY) return { source: "template", ...templateNarrative(summary) };
  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `本日の予測パイプライン出力です。住民向けの解説を作成してください。\n\n${JSON.stringify(summary)}`,
      }],
    });
    if (response.stop_reason === "refusal") {
      console.warn("[narrative] refused:", response.stop_details?.category ?? "unknown");
      return { source: "template", ...templateNarrative(summary) };
    }
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return { source: response.model, ...JSON.parse(text) };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.warn("[narrative] rate limited");
    else if (err instanceof Anthropic.APIError) console.warn(`[narrative] API error ${err.status}: ${err.message}`);
    else console.warn("[narrative] failed:", err.message);
    return { source: "template", ...templateNarrative(summary) };
  }
}

function templateNarrative(s) {
  const [d0, d1] = s.daily;
  const cat = (d) => `${d.aqi.category}（AQI ${d.aqi.value}）`;
  const pBad = (d) => Math.round(d.pm25.probOver35 * 100);
  return {
    headline: `今日は${cat(d0)}の見込み`,
    summary: `本日のPM2.5 24時間平均は約${d0.pm25.p50}µg/m³（80%区間 ${d0.pm25.p10}–${d0.pm25.p90}）。`
      + `明日は${cat(d1)}、AQI 100超の確率は${pBad(d1)}%。主な要因: ${s.drivers.slice(0, 2).map((d) => d.name).join("、")}。`,
    outlook: s.daily.map((d) => ({
      date: d.date,
      comment: `${cat(d)}。PM2.5 ${d.pm25.p50}µg/m³、ヘイズリスク${d.haze.riskLabel}、気流は${d.haze.origin.ja}から。`,
    })),
    advice: {
      general: d0.aqi.value <= 100 ? "通常どおり屋外活動して問題ありません。" : "長時間の激しい屋外運動は控えめに。",
      sensitive: d0.aqi.value <= 50 ? "特別な配慮は不要です。" : "症状が出たら屋外活動を減らし、マスクの着用を検討してください。",
      best_outdoor_window: s.bestWindow ? `${s.bestWindow.from}〜${s.bestWindow.to}頃が比較的きれいな空気です。` : "時間帯による差は小さい見込みです。",
      windows_and_purifier: d0.aqi.value > 100 ? "窓を閉め、空気清浄機を強めで運転しましょう。" : "換気は問題ありません。",
    },
    haze_comment: `現在は${s.season.ja}。本日のヘイズリスク指数は${d0.haze.riskIndex}/100（${d0.haze.riskLabel}）。`,
    confidence_comment: "ANTHROPIC_API_KEY 未設定のため、定型文で表示しています。",
  };
}
