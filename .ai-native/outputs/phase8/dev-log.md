# Phase 8: フルスケール実装 開発ログ

## 実施日
2026-07-24（オペレーター指示「全ての機能を本格化してください」+ 本番フィードバック対応）

## 本格化した機能

| # | 項目 | Before（MVP） | After（Phase 8） | 主なファイル |
|---|------|--------------|-----------------|-------------|
| 1 | 資金フロー | 出来高×騰落率の推定モデル | **Binance テイカーフロー実測**（kline のテイカー買い/売り quote 出来高から銘柄別ネットフローを算出。未上場銘柄は推定補完、失敗時は従来モデルへフォールバック） | `shared/binance.ts`, `shared/flow.ts`, `stores/market.ts` |
| 2 | 価格更新 | 15 秒ポーリングのみ | **Binance WebSocket miniTicker で即時ティック**（13 銘柄。自動再接続・ポーリングはメタデータ担当で継続） | `stores/market.ts` |
| 3 | RAG | 選択中戦略の注入のみ（検索未配線） | **戦略ライブラリからのベクトル検索**（Vertex text-embedding-005 + コサイン類似度・埋め込みメモリキャッシュ。未設定時はキーワード検索）を 3 エンドポイントに配線 | `server/utils/rag.ts`, `server/utils/vertex.ts` |
| 4 | ニュース | 英語 2 ソース + トレンド | **5 ソース**（CoinPost / Cointelegraph JP 追加）+ **銘柄関連見出しの優先フィルタ** | `server/utils/news.ts` |
| 5 | 実トレード | 買い方向のみ | **売り方向（トークン→SOL）対応**（SPL 残高取得・decimals 変換・全量ボタン・ガードは受取 SOL の USD 換算で判定） | `stores/wallet.ts`, `pages/trade/live.vue` |
| 6 | アカウント | 匿名のみ（データ全損リスク） | **Google アカウントリンク**（uid 不変でデータ引き継ぎ。AUDIT-9 の本対応） | `composables/useFirebase.ts`, `components/AccountLink.vue` |
| 7 | AI API 防御 | IP レートリミットのみ | **Firebase ID トークン検証（jose + 公開 JWKS）+ 段階レート**（認証済み uid 40/分・匿名 IP 20/分・`NUXT_AI_REQUIRE_AUTH=true` で認証必須化） | `server/utils/firebaseAuth.ts`, `server/middleware/ai-rate-limit.ts` |
| 8 | UI 品質 | 絵文字アイコン | **lucide（@lucide/vue）へ全面刷新**。バブルマップは過密解消（中心引力弱化・反発強化・べき圧縮の半径）+ **ドラッグ/スワイプ対応** | 全ページ, `components/BubbleMap.vue` |
| 9 | PWA アイコン | 単純なバブル | フロー矢印付きのバブル構成へ刷新 | `public/icons/` |

## 本番障害の修正（同時対応）

- **/trade 配下が遷移しない:** `pages/trade.vue` が親ルート化し子ページの出口（NuxtPage）が無かった
  → `pages/trade/index.vue` へ移動して兄弟ルート化。**Playwright で全 8 ルートの描画とクライアントサイド遷移を実機検証**

## 検証

- テスト 95 件（単体 59 / 結合 30 / シナリオ 6）全パス
- `nuxt build`（通常 + firebase プリセット）成功
- Playwright スモーク: 全ルート PASS・`/trade → /trade/demo` のクライアント遷移 PASS・フロー画面のスクリーンショット確認

## 技術判断

- `lucide-vue-next@1.0.0` は deprecated（後継 `@lucide/vue` へ移行せよとの告知）のため **公式後継 `@lucide/vue` を採用**
- 銘柄間の個別フロー経路は公開データが存在しないため、実測ネットフローの**比例配分**とし UI に明示
- 実測が 5 銘柄未満しか取れない場合は全体を推定モデルに委ねる（信頼性の混在を避ける）
- AI 自動実トレードの署名は引き続き必ず手動（Phantom 仕様 + 資金保護。カストディアル化はスコープ外）

## 残課題

- Firestore Vector Search による埋め込みの永続化（現在はメモリキャッシュ）
- Token-2022 プログラムのトークン残高対応（現在は SPL Token のみ）
- WalletConnect 対応
