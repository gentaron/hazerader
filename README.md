# HazeRadar 🌫️

**Mutiara Ville, Cyberjaya** の大気汚染指数（US AQI）を、AI アンサンブルで毎日1回予測する PWA。

- 📱 PWA（ホーム画面に追加、オフライン表示対応）
- 🕕 毎朝 06:17 (MYT) に GitHub Actions で1日1回だけ更新 → コミットを受けて Netlify が自動再デプロイ
- 📈 PM2.5 の120時間予測（80% 予測区間つき）と5日間の AQI・AQI 100 超の確率
- 🔥 ヘイズ診断（850hPa の気流の起源、モンスーン期、風上の火災ホットスポット）
- 🤖 予測モデルの要因分析から、日本語の解説と健康アドバイスを自動生成
- 💸 **完全無料**：有料 API なし・依存パッケージなし。無料の Open-Meteo と公開リポジトリの GitHub Actions と Netlify 無料枠だけで動く
- 🔁 自分の過去予測を毎日答え合わせして、ブレンド重みと予測区間の幅を自動で学習

## 予測エンジン

| メンバー | 中身 |
|---|---|
| **CAMS** | ECMWF Copernicus の化学輸送モデル（排出・化学・越境輸送を物理計算） |
| **気象ML** | リード時間ごとの直接多ホライズン・リッジ回帰（1〜120h の9本）。換気能（混合層高×風速）、降水、湿度、850hPa のモンスーン気流、日周期・週周期と PM2.5 の関係を過去92日から学習し、**ECMWF / GFS / ICON** の3つの数値予報で個別に駆動 |
| **持続** | 直近24h の水準を長期平均へ減衰させ、学習した日周期を重ねたもの |

1. 3メンバーを対数空間で **逆MSE重み付け** でブレンド（重みはホールドアウト検証を事前分布、日々の答え合わせを指数加重で更新）
2. 予測区間 = ブレンド誤差 + アンサンブルの不一致。実際の誤差で幅を自動キャリブレーション
3. 地上局の観測（WAQI）があれば、CAMS に対する局所バイアスを学習して補正
4. AQI は US EPA 2024 基準（PM2.5 24h / PM10 24h / O₃ 8h / NO₂ 1h の最大）

`pipeline/` が予測パイプライン（Node 22、外部パッケージ依存ゼロ）、`site/` が PWA 本体です。

## セットアップ

1. このブランチを `main` にマージ
2. Netlify でこのリポジトリを連携（`netlify.toml` で公開ディレクトリ `site/` を指定済み。ビルド不要）
3. （任意）**Settings → Secrets and variables → Actions** に無料キーを追加。なくても動くけど、入れるほど賢くなる

| Secret | 用途 |
|---|---|
| `WAQI_TOKEN` | 無料。最寄り DOE 局の実測値でバイアス補正（[aqicn.org/data-platform/token](https://aqicn.org/data-platform/token/)） |
| `FIRMS_MAP_KEY` | 無料。NASA FIRMS の VIIRS 火災ホットスポット（[firms.modaps.eosdis.nasa.gov/api/map_key](https://firms.modaps.eosdis.nasa.gov/api/map_key/)） |

座標を変えたい場合は Variables に `HZ_LAT` / `HZ_LON` を設定。

4. **Actions → Daily AQI forecast → Run workflow** で初回実行（以降は毎朝自動）

## ローカル

```bash
cd pipeline
npm test                 # 合成データで8日分の運用を模擬する end-to-end テスト
node src/run.mjs         # 実データで予測（1日1回ガードあり。HZ_FORCE=1 で再発行）
cd ../site && python3 -m http.server   # http://localhost:8000
```

## 注意

これは研究・情報提供目的の予測です。公式の大気質情報は DOE の [APIMS](https://eqms.doe.gov.my/APIMS/main) を確認してください。
学習・検証の「正解」は、地上局を設定しない限り CAMS の解析値です。
