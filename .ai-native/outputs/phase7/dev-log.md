# Phase 7: MVP 開発ログ

## 実施日
2026-07-24（単一セッションで Phase 0-7 を圧縮実施。オペレーター要件が事前確定していたため）

## 実装スコープ（機能一覧との対応）

| 機能 ID | 実装 | 主なファイル |
|---------|------|-------------|
| F-01 リアルタイム価格 | ✅ | `stores/market.ts`, `pages/index.vue`, `components/PriceCard.vue` |
| F-02 バブルマップ | ✅ | `shared/flow.ts`, `components/BubbleMap.vue`, `pages/flows.vue` |
| F-03 AI インサイト | ✅ | `server/api/ai/insight.post.ts`, `shared/advisor.ts`, `pages/insights.vue` |
| F-04 AI デモトレード | ✅ | `shared/tradeEngine.ts`, `stores/demoTrade.ts`, `pages/trade/demo.vue` |
| F-05 Solana スクリーニング | ✅ | `shared/solanaScoring.ts`, `stores/solana.ts` |
| F-06 Solana 自動取引 | ✅ | `shared/degenAdvisor.ts`, `server/api/ai/degen-decision.post.ts`, `pages/trade/solana.vue` |
| F-07 ウォレット実トレード | ✅ | `stores/wallet.ts`, `pages/trade/live.vue`（Jupiter v6 + Phantom） |
| F-08 実トレードガード | ✅ | `shared/tradeGuard.ts`（同意 + 上限 + 自動化ゲート） |
| F-09 RAG 戦略設定 | ✅ | `shared/strategyPresets.ts`（プリセット5種）, `stores/strategy.ts`, `pages/strategy.vue` |
| F-10 ニュース収集 | ✅ | `server/utils/news.ts`, `server/api/news.get.ts` |
| F-11 永続化 | ✅ | `composables/usePersistence.ts`, `composables/useFirebase.ts`, `firestore.rules` |
| F-12 PWA | ✅ | `nuxt.config.ts`（@vite-pwa）, `public/icons/`（生成スクリプトで作成） |

## テストゲート

| ステージ | 件数 | 結果 |
|---------|------|------|
| 単体（`pnpm run test:unit`） | 45 | ✅ 全パス |
| 結合（`pnpm run test:integration`） | 19 | ✅ 全パス |
| シナリオ（`pnpm run test:scenario`） | 6 | ✅ 全パス |
| ビルド（`NITRO_PRESET` なし / firebase 両方を想定した nuxt build） | — | ✅ 成功 |

## 技術的な特記事項・判断

1. **npm の arborist バグ回避:** `npm install` が `edgesOut` エラーで失敗したため pnpm を採用。
   `pnpm.onlyBuiltDependencies` で esbuild 等のビルドスクリプトを明示許可
2. **フロー推定モデル:** 実フローの公開データが存在しないため「出来高加重の相対モメンタム差」
   による推定と明記（UI にも「推定値」表示）
3. **PS 5.1 対応:** 既存の `setup-deploy-secrets.ps1`（PS 7.1+）は汎用テンプレートとして温存し、
   Cryptia 専用の `setup-cryptia-secrets.ps1`（PS 5.1 / UTF-8 BOM 付き）を新設
4. **実トレードの範囲:** MVP は SOL→トークンの買いスワップのみ。売却はウォレット側で実施
   （UI・ナレッジベースに明記。将来拡張: トークン decimals 解決と売り方向対応）

## 残課題（Phase 8 以降へ）

- Vertex AI Embeddings + Firestore Vector Search による本格 RAG（現在はキーワード注入）
- WalletConnect 対応・売り方向スワップ
- Binance WebSocket による秒級ティック（現在 15 秒ポーリング）
- Phase 6（実ユーザーフィードバック）はオペレーターによるプロトタイプ確認後に実施
