# Phase 8: レビュー結果（品質ゲート・安全ゲート）

> Phase 8 差分（本格化 9 項目 + 障害修正 + エントリーレンジ機能）に対する
> コードレビュアー / システム監査官の反復レビュー記録。

## イテレーション 1

### コードレビュアー: 指摘 11 件（Medium 5 / Low 6）

| # | 重要度 | 指摘 | 対応 |
|---|--------|------|------|
| ISSUE-P8-1 | Medium | 売り確認ダイアログの表示数量がクランプ後の実行値と乖離 | 表示を quote.inAmount 由来に変更 + 見積り時に入力値をクランプ書き戻し |
| ISSUE-P8-2 | Medium | Token-2022 トークンの残高が取得されず売却不能 | 両プログラム ID を並行クエリしマージ |
| ISSUE-P8-3 | Medium | 単一 loading フラグで期間切替時の実測フロー取得が黙って落ちる | 期間別の loading 管理へ変更 |
| ISSUE-P8-4 | Medium | RAG のクエリ埋め込みが RETRIEVAL_DOCUMENT 固定で検索品質が崩れる | QUERY/DOCUMENT の非対称埋め込みに分離・閾値再調整 |
| ISSUE-P8-5 | Medium | 匿名認証の量産で uid レート枠を無制限バイパス可能 | 認証済みも IP バックストップ（60/分）を併用する二重キー化 |
| ISSUE-P8-6 | Low | WS onclose がソケット同一性を確認せず孤児ソケットが残り得る | `this._ws !== ws` ガード追加 |
| ISSUE-P8-7 | Low | disconnect() が tokenBalances をクリアしない | クリア追加 |
| ISSUE-P8-8 | Low | E303 が定数未参照のリテラル | ERROR_CODES.AUTH_REQUIRED を参照 |
| ISSUE-P8-9 | Low | ニュース銘柄フィルタの substring 誤ヒット（SUI×lawsuit 等） | 英字タームは単語境界照合へ変更 + 回帰テスト |
| ISSUE-P8-10 | Low | ドラッグ長押し中に速度が蓄積しバブルが吹き飛ぶ | 力の加算からドラッグ中ノードを除外 |
| ISSUE-P8-11 | Low | WebView でポップアップ連携が失敗し代替なし | linkWithRedirect フォールバック + getRedirectResult 完了処理 |

### システム監査官: 指摘 3 件（Medium 1 / Low 2）/ リリース可否 OK

| # | 重要度 | 指摘 | 対応 |
|---|--------|------|------|
| AUDIT-P8-1 | Medium | ID トークンの aud/iss 検証が gcpProjectId 優先でマルチプロジェクト構成時に静かな全降格 | firebaseProjectId 優先へ反転 |
| AUDIT-P8-2 | Low | 売りの日次上限計上が受取 SOL 基準で高スリッページ時に過小 | 受取 SOL 価値と売却トークン参照価値の大きい方を計上 |
| AUDIT-P8-3 | Low | ＝ ISSUE-P8-8（重複） | 同上 |

**監査で問題なしと確認された事項:** alg confusion 不可（jose+JWKS）/ 売却の資金喪失経路なし（全経路署名必須）/
BigInt クランプで保有超過売り不可 / WS・埋め込みキャッシュ・レートバケットは全て有界 /
RAG コスト増幅は検証上限とレート枠で有界 / NUXT_AI_REQUIRE_AUTH 配線一気通貫 / ドキュメント整合。

### 修正後の検証
- テスト 98 件（単体 59 / 結合 33 / シナリオ 6）全パス・ビルド成功
- Playwright: 全 8 ルート描画 + クライアント遷移 PASS（イテレーション前に実施）

## イテレーション 2（最終検証）

（両ロールによる修正確認の結果を追記する）
