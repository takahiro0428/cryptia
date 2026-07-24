# エラーコード逆引きリファレンス

すべての想定エラーは `app/shared/errors.ts` で一元管理される（SoT）。
本書はコードから原因・対処を逆引きするための運用者向けリファレンス。

| コード | 意味 | 主な原因 | ユーザー影響 | 対処 |
|--------|------|---------|-------------|------|
| CRYPTIA-E101 | 価格 API 取得失敗 | CoinGecko 障害・レートリミット・オフライン | 最終キャッシュ or モック表示（警告バナー） | 自動リトライ（15s 間隔）。頻発時は CoinGecko ステータス確認 |
| CRYPTIA-E102 | DEX API 取得失敗 | DexScreener 障害 | Solana リストがモック表示 | 自動リトライ（30s 間隔） |
| CRYPTIA-E103 | ニュース取得失敗 | RSS 障害・ネットワーク | AI はテクニカルのみで分析継続 | 5 分キャッシュ経由で自動回復 |
| CRYPTIA-E201 | Vertex AI 呼び出し失敗 | 認証・API 無効・タイムアウト | フォールバック分析に自動切替（engine:'fallback' 表示） | Functions SA の `roles/aiplatform.user` 権限、`NUXT_GCP_PROJECT_ID` 設定を確認 |
| CRYPTIA-E202 | AI 応答の解析失敗 | Gemini の JSON 逸脱 | 同上 | 頻発時はモデル/プロンプト見直し（`NUXT_VERTEX_MODEL`） |
| CRYPTIA-E301 | 入力検証エラー | 不正リクエスト（改竄・バグ） | 該当操作が 400 で拒否 | Cloud Logging でリクエスト内容確認。頻発時は攻撃を疑う |
| CRYPTIA-E302 | AI API レートリミット超過 | 同一 IP から毎分 20 リクエスト超（濫用・ボット） | 該当 IP の AI 呼び出しが 429 で拒否 | 正常な防御動作。正規ユーザーで頻発する場合は `server/utils/rateLimit.ts` の上限を見直す |
| CRYPTIA-E401 | デモ: 資金不足 | 残高超過の買い注文 | 注文スキップ（ログのみ） | 正常動作（資金管理ガード） |
| CRYPTIA-E402 | デモ: 数量不足 | 保有超過の売り注文 | 注文スキップ | 正常動作 |
| CRYPTIA-E501 | 実トレード: ガード未設定 | リスク同意・上限が未設定のまま注文/自動化 | 注文ブロック | ユーザーに取引ガード設定を案内 |
| CRYPTIA-E502 | 実トレード: 上限超過 | 1回/1日上限を超える注文 | 注文ブロック | 正常動作（安全ガード）。上限は戦略画面でなくガード設定で変更 |
| CRYPTIA-E503 | ウォレット未接続 | Phantom 未検出・接続拒否 | 実トレード不可 | Phantom 導入 / アプリ内ブラウザ利用を案内 |
| CRYPTIA-E504 | スワップ見積り失敗 | Jupiter 障害・流動性不足・不正ミント | 注文中断 | トークン・数量を変えて再試行。Jupiter ステータス確認 |
| CRYPTIA-E601 | Firestore 同期失敗 | ルール拒否・オフライン・未設定 | ローカル保存で継続（データ損失なし） | Firebase 設定（NUXT_PUBLIC_FIREBASE_*）と Rules デプロイを確認 |
| CRYPTIA-E999 | 未分類エラー | 想定外の例外 | 操作による | Cloud Logging / ブラウザコンソールのスタックトレースを確認し、エラーコードの新設を検討 |

## ログの見方

- **クライアント:** ブラウザコンソールに `[CRYPTIA-Exxx] メッセージ` 形式で出力。ユーザーにはトーストで同コードを表示
- **サーバー:** Cloud Logging（Cloud Functions `server`）に同形式で出力。`resource.type="cloud_run_revision"` でフィルタし `CRYPTIA-E` を検索
