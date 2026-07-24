# Phase 7: レビュー結果（品質ゲート・安全ゲート）

> SP-8 / 原則9 に基づき、コードレビュアーとシステム監査官の独立レビューを
> 指摘ゼロになるまで反復実施した記録。

## イテレーション 1（初回レビュー・監査）

### コードレビュアー（7視点）: 指摘 7 件（High 2 / Medium 4 / Low 1）

| # | 重要度 | 指摘 | 対応 |
|---|--------|------|------|
| ISSUE-1 | High | firestore.rules の read 条件が `request.resource` を参照し全 read が拒否される | read/delete と create/update に条件を分離 |
| ISSUE-2 | High | executeOrder の notional→数量逆算の浮動小数点誤差で全量売却が間欠失敗・ダスト残留 | quantity 指定 I/F を追加。相対許容誤差判定・全量丸め・ダスト削除。回帰テスト3件追加 |
| ISSUE-3 | Medium | AI モード tick の await 中にセッション終了/再開始されると旧判断を新セッションに執行 | 両ストアに世代カウンタ `_session` を導入し await 後に再検証 |
| ISSUE-4 | Medium | 実トレード画面の AI おすすめにモックの架空トークンが警告なしで表示 | モック時は aiPicks を空にし警告バナー表示 |
| ISSUE-5 | Medium | PS1 の `gh auth status 2>&1` が PS5.1 + EAP=Stop で NativeCommandError | Invoke-NativeQuiet ヘルパーで EAP 退避。両スクリプトに適用 |
| ISSUE-6 | Medium | 魔界注文履歴の銘柄欄にペアアドレスが生表示されモバイルレイアウト崩壊 | OrderList に symbolResolver プロップ + 長 ID 短縮 + flex-wrap |
| ISSUE-7 | Low | solana の再開が永続化されずリロードで停止状態に巻き戻る | startTicking で即時 _persist + 即時 tick（両ストア） |

### システム監査官: 指摘 9 件（High 2 / Medium 3 / Low 4）/ リリース可否 NG

| # | 重要度 | 指摘 | 対応 |
|---|--------|------|------|
| AUDIT-1 | High | 価格 API 障害時、実トレードの上限ガードがモック価格で判定される | priceReady 判定（モック/鮮度2分超で false）で実トレード機能を全停止 + バナー表示 |
| AUDIT-2 | High | 認証・レートリミットなしの /api/ai/* が Vertex AI への無料プロキシになる | IP 単位レートリミット（20req/分・429/E302）+ プロンプトの untrusted 隔離。認証必須化/App Check は Phase 8 残課題（下記「オペレーター判断事項」） |
| AUDIT-3 | Medium | Firestore ルールが任意 stateKey・900KB 書込を許容（コスト濫用） | stateKey ホワイトリスト + hasOnly + 256KB 上限 |
| AUDIT-4 | Medium | ＝ ISSUE-4（重複） | 同上 |
| AUDIT-5 | Medium | デプロイログのシークレット除去が完全一致のみで SA JSON 断片が漏れる | sed パターン除去（ya29/private_key/SA メール/PEM ブロック）を追加 |
| AUDIT-6 | Low | RSS 由来 URL の javascript: リンク XSS・見出しのプロンプト注入 | https のみ許可・制御文字除去・untrusted 隔離 |
| AUDIT-7 | Low | 日次上限会計が並行実行・複数タブで古い値のまま判定される | executeSwap の busy 排他 + 判定直前にローカルログ再取込 |
| AUDIT-8 | Low | firebase-tools / pnpm のバージョン非固定（サプライチェーン） | 14.27.0 / 10.34.5 に完全固定 |
| AUDIT-9 | Low | 匿名認証のため端末データ消去で実トレード履歴が全損 | 履歴の JSON エクスポート/インポート + 制約の UI 明示。アカウントリンクは Phase 8 残課題 |

### 修正後の検証
- テスト 78 件（単体 48 / 結合 24 / シナリオ 6）全パス。修正対象の回帰テストを 5 件追加
- `nuxt build` 成功

## オペレーター判断事項

1. **AI API の認証必須化（AUDIT-2 関連）:** MVP は摩擦のない匿名利用を優先し、防御はレートリミット
   + プロンプト隔離 + Functions maxInstances 上限で構成した。本番運用で課金リスクを厳格化する場合は
   Firebase App Check + 匿名認証トークン検証の追加を推奨（Phase 8 残課題として記録済み）
2. **既知リスク:** `.claude.json` の GitHub PAT（初期コミット由来・許容リスト登録済み）は
   発行元での revoke とローテーションを推奨

## イテレーション 2（修正検証 + 新規指摘）

### 検証結果
- **コードレビュアー:** ISSUE-1〜7 全件 RESOLVED を実コードで確認（テスト 78 件パスも再実行で確認）
- **システム監査官:** AUDIT-1〜9 全件 RESOLVED / ACCEPTED-WITH-CONDITION
  - AUDIT-2 は「認証必須化/App Check は Phase 8 残課題（オペレーター判断）」の条件付き承認
  - AUDIT-7 の別デバイス間同時実行は Low・稀として許容範囲と判定

### 新規指摘（修正パッチ起因）: 3 件

| # | 重要度 | 指摘 | 対応 |
|---|--------|------|------|
| AUDIT-10 / ISSUE-9 | Medium/Low | レートリミッタが XFF 左端を信頼しヘッダ偽装でバイパス可能 + バケット増加ベクタ | clientIp() を XFF 右端基準に変更（NUXT_TRUSTED_PROXY_HOPS で調整可）。MAX_BUCKETS=10000 のフェイルクローズ追加 |
| AUDIT-11 / ISSUE-8 | Medium/Low | importLog の検証不足で日次上限ガードが NaN 化しバイパス可能 | isValidTradeRecord() による全件検証を取込・復元・再取込の 3 経路に適用 + assertTradeAllowed で todaysSpentUsd の有限性検証（多層防御） |
| ISSUE-10 | Low | 戦略名（ユーザー入力）が untrusted フェンス外のラベル行に注入可能 | ラベルを固定文言化し strategy.name をフェンス内へ移動（3 エンドポイント） |

- 回帰テスト 3 件追加 → テスト 80 件（単体 49 / 結合 25 / シナリオ 6）全パス・ビルド成功

## イテレーション 3（最終検証）

- **コードレビュアー:** ISSUE-8 / 9 / 10 全件 RESOLVED を実コードで確認。テスト 80 件パスを再実行で確認。
  **残存指摘 0 件（品質ゲート CLEAR）**
- **システム監査官:** AUDIT-10 / 11 RESOLVED。ただし AUDIT-10 修正の配線漏れとして
  AUDIT-12（`NUXT_TRUSTED_PROXY_HOPS` が deploy.yml で未受け渡し・Medium）を新規検出

### イテレーション 4（AUDIT-12 対応）

| # | 指摘 | 対応 |
|---|------|------|
| AUDIT-12 | NUXT_TRUSTED_PROXY_HOPS がパイプラインに配線されておらず本番でホップ数調整不能 | deploy.yml の deploy ステップ env に受け渡し追加・setup-cryptia-secrets.ps1 に -TrustedProxyHops（既定1）追加・deploy-guide.md に初回デプロイ後の XFF 実測ランブック追記 |

- **システム監査官 最終判定: 残存指摘 0 件 / リリース可否 OK（安全ゲート PASS）**

## 最終結果

| ゲート | 判定 | 経過 |
|--------|------|------|
| 品質ゲート（コードレビュアー） | ✅ CLEAR | 指摘 10 件 → 全件解消（3 イテレーション） |
| 安全ゲート（システム監査官） | ✅ PASS | 指摘 12 件 → 全件解消（4 イテレーション） |
| テストゲート | ✅ 80 件全パス（単体 49 / 結合 25 / シナリオ 6） |
| ビルド | ✅ 成功 |

### オペレーターへの引き継ぎ事項（承認・実施待ち）

1. **初回デプロイ後の実測:** Cloud Logging で X-Forwarded-For を確認し `NUXT_TRUSTED_PROXY_HOPS` を確定する（deploy-guide.md §3）
2. **Phase 8 残課題:** Firebase App Check / AI API 認証必須化、匿名アカウントの永続ログインへのリンク、売り方向スワップ、本格ベクトル RAG
3. **既知リスク:** `.claude.json` の GitHub PAT（初期コミット由来・許容リスト登録済み）の revoke とローテーション
4. **Phase 7 ゲートのオペレーター承認:** 本レビューサマリーの承認とリリース判断
