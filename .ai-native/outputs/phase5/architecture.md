# Phase 5: アーキテクチャ設計

## 全体構成

```mermaid
flowchart TB
    subgraph Client["クライアント（PWA / Nuxt 3 SPA）"]
        Pages["pages/<br/>7画面"] --> Stores["stores/ (Pinia)<br/>market・insights・demoTrade<br/>solana・strategy・wallet・ui"]
        Stores --> Shared["shared/<br/>純ロジック層（同型）"]
        SW["Service Worker<br/>(@vite-pwa)"]
    end
    subgraph Server["Nitro server/api（Firebase Cloud Functions gen2）"]
        API["/api/ai/insight<br/>/api/ai/decision<br/>/api/ai/degen-decision<br/>/api/news"]
        API --> SharedS["shared/（同一コード）"]
        API --> Vertex["utils/vertex.ts<br/>Vertex AI Gemini"]
        API --> News["utils/news.ts<br/>RSS + トレンド収集"]
        API --> Valid["utils/validation.ts<br/>全入力検証"]
    end
    subgraph Ext["外部公開 API"]
        CG["CoinGecko<br/>価格・時価総額"]
        DS["DexScreener<br/>Solana ペア"]
        JUP["Jupiter<br/>スワップ"]
        RSSF["CoinDesk / Cointelegraph RSS"]
    end
    FS[(Firestore<br/>cryptia-users/{uid}/state)]
    Wallet["ウォレット<br/>Phantom / Bitget / Solflare"]

    Stores -->|直接fetch| CG
    Stores --> DS
    Stores -->|"$fetch"| API
    Vertex --> GeminiAPI["Vertex AI"]
    News --> RSSF
    Stores -->|同期キャッシュ| FS
    Pages --> Wallet
    Wallet --> JUP
```

## レイヤー責務

| レイヤー | 責務 | 障害時の振る舞い（BR-5） |
|---------|------|------------------------|
| `shared/` | 型・エラーコード・テクニカル指標・フロー推定・売買判断・取引エンジン・スコアリング（純関数） | — （外部依存なし。全テストの主対象） |
| `stores/` | 状態管理・外部 API フェッチ・永続化・ティック実行 | 価格/DEX/RPC→サーバープロキシへ自動フォールバック→モック/最終キャッシュ、AI→ローカルロジック |
| `server/api` | AI キー秘匿・入力検証・ニュース収集・Gemini 呼び出し | Vertex 失敗→`shared/advisor` フォールバック |
| `composables/` | Firebase 遅延初期化・ローカル/リモート永続化 | Firebase 未設定→ローカルのみで全機能動作 |

## 設計上の重要判断

1. **同型ロジック（isomorphic shared/）:** AI 判断のフォールバックロジックをクライアント・サーバーで共有。
   オフラインでもデモトレードが完全動作し、テストは外部依存なしで全パスを検証できる。
2. **AI 呼び出しはサーバー経由のみ:** Vertex AI の認証情報（ADC）はクライアントに一切露出しない。
   クライアントからの入力は `validation.ts` で全件検証（銘柄マスタ・数値範囲・文字列長）。
3. **署名の端末内完結（BR-1 改訂）:** 既定はウォレット署名（Phantom / Bitget Wallet / Solflare 等）で、メインウォレットの秘密鍵は非保持。F-13 ボットウォレット自動実行のみ、専用生成鍵を PBKDF2 + AES-GCM で暗号化して端末 localStorage に保管し（Firestore 同期なし・平文はメモリのみ）、自動署名に用いる。サーバー（RPC プロキシ）は署名済み Tx の中継のみで署名能力を持たない。
   **F-13 の残存リスク（設計判断として明記）:**
   (a) パスフレーズ解除中はページ上で実行されるコード（XSS・悪性拡張）がボット鍵で署名可能 —
   ロック機能・端末限定保管・「失っても許容できる金額」の運用前提で緩和（排除は不能）。
   (b) 弱いパスフレーズは暗号化 blob 窃取時のオフライン総当たりに弱い（PBKDF2 310k で遅延・8 文字下限）。
   (c) 秘密鍵バックアップのコピーはクリップボード同期系アプリへ平文が渡り得る（表示は明示操作のみ）。
   (d) localStorage 改竄による出金先すり替えは AES-GCM の AAD 束縛で解除時に検出（実行中の注入は (a) と同じ）。
   (e) sendTransaction 後の確認タイムアウト（不明）時、買いは記録・売りは再試行に倒す — 買いの
   幻ポジションは全量売却時の実残高照合で自然消滅、売りの再試行は比率を問わず実残高照合で二重執行を防止（着地済みなら段を確定して送信しない）。
   (f) 出口価格は DexScreener 単一系統に依存 — 障害・プール移行中は出口判定がスキップされる
   （フォールバック価格源は将来課題）。(g) 日次上限の日付は UTC 基準（日本時間 朝 9 時リセット）。
   (h) 非表示タブではブラウザのタイマー抑制で執行間隔が延びる。
   (i) ドロップした買い Tx も日次消費に計上する（上限が早く締まる方向の安全側誤差）。
   (j) パスフレーズ失念時は UI から削除できない（サイトデータの手動消去が必要。資金はバックアップ鍵からのみ回収可能）
4. **追記型データ（BR-7）:** 注文・取引ログ・アーカイブは追記のみ。エンジンは immutable 更新で
   巻き戻しバグを構造的に防止する。
5. **SoT 宣言（原則6）:** ユーザーデータの SoT はクライアント操作結果（ローカルストレージ）。
   Firestore は同期キャッシュであり、書込は「ローカル→Firestore」の順に限定（data-design.md 参照）。

## デプロイ構成

```mermaid
flowchart LR
    Dev["git push /<br/>workflow_dispatch"] --> Preflight["事前検証<br/>設定値チェック"]
    Preflight --> Test["テストゲート<br/>単体→結合→シナリオ"]
    Test -->|全通過| Deploy["deploy-firebase.sh<br/>build + firebase deploy"]
    Test -->|失敗| Halt["中断 + Step Summary +<br/>deploy-logs アーティファクト"]
    Deploy --> H["Firebase Hosting<br/>target: cryptia（サイト名可変）"]
    Deploy --> F["Cloud Functions gen2<br/>codebase: cryptia / 関数名 cryptiaserver"]
    Deploy -.->|"DEPLOY_FIRESTORE_RULES=true"| R["Firestore Rules<br/>（専用DB cryptia のみ）"]
```

> **共有プロジェクトでの同居:** Functions は codebase `cryptia`・関数名 `cryptiaserver`、
> Hosting は target `cryptia`（`FIREBASE_HOSTING_SITE` で実サイトへバインド）、
> Firestore は**専用の名前付きデータベース `cryptia`**（+ コレクション `cryptia-` prefix の多層防御）。
> Security Rules はデータベース単位のため、ルールのデプロイも他アプリへ影響しない。

- テストゲート: `UNIT_TEST_CMD` → `INTEGRATION_TEST_CMD` → `SCENARIO_TEST_CMD`（既存パイプラインを再利用: 原則3）
- シークレット: repository secrets（`DEPLOY_TOKEN` = SA JSON / `DEPLOY_TARGET` = プロジェクト ID）
- 監視: Cloud Logging（Functions の構造化ログにエラーコード `CRYPTIA-Exxx` を出力）
