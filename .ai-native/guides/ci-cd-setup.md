---
document_id: ci-cd-setup
type: guide
version: 1.0.0
purpose: GitHub Actions ワークフロー（ラベル・Issue自動化・PRチェック・同期・デプロイ）のセットアップ手順書
---

# CI/CD セットアップ手順書

本リポジトリ（およびテンプレートから作成したプロジェクトリポジトリ）の
GitHub Actions ワークフローのセットアップ手順。

**デプロイパイプラインの詳細な運用手順は [`deploy-guide.md`](deploy-guide.md) を参照。**

---

## §1 ワークフロー一覧

| ワークフロー | トリガー | 用途 | 必要な設定 |
|-------------|---------|------|-----------|
| `label-setup.yml` | 手動実行 | 30個のプロジェクトラベルを一括作成 | なし（GITHUB_TOKEN で動作） |
| `issue-labeler.yml` | Issue作成時 | テンプレート項目からラベルを自動付与 | なし |
| `pr-checks.yml` | PR作成・更新時 | Issue参照・セルフチェックの確認＋ドキュメント整合性検証 | なし |
| `sync-external-repo.yml` | 手動実行 | 外部リポジトリからの同期PR作成 | secret: `SYNC_REPO_TOKEN` |
| `deploy.yml` | 手動実行 | テストゲート付きデプロイパイプライン | [`deploy-guide.md`](deploy-guide.md) §3 参照 |

---

## §2 初期セットアップ

### 2-1. ラベルの一括作成

リポジトリ作成後に1回、GitHub Actions から手動実行する。

1. **Actions** タブ → **ラベル一括セットアップ / Label Setup** → **Run workflow**
2. `--force` フラグ付きで作成されるため、再実行しても安全（冪等）

CLI から実行する場合（PowerShell）:

```powershell
gh workflow run label-setup.yml --repo owner/repo
```

### 2-2. Issue自動ラベリング・PRチェック

`issue-labeler.yml` / `pr-checks.yml` は追加設定なしで動作する。
Issue・PRテンプレート（`.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`）と
連動しているため、テンプレートの見出しを変更した場合はワークフロー側の抽出ロジックも
更新すること（コードとドキュメントの一貫性）。

### 2-3. 外部リポジトリ同期（テンプレート管理者向け）

`sync-external-repo.yml` は同期元リポジトリへのアクセストークンを必要とする。

```powershell
# 同期元リポジトリの read 権限を持つ PAT を登録（値は非表示入力。PowerShell 7.1 以降）
Read-Host -Prompt "SYNC_REPO_TOKEN" -MaskInput | gh secret set SYNC_REPO_TOKEN --repo owner/repo
```

> **保護リスト:** 同期は `rsync --delete` で行われるため、同期元に存在しない
> リポジトリ固有ファイルは削除される。このリポジトリ固有のファイルを追加した場合は、
> 必ず `.github/sync-protect.txt` に追記して保護すること。

> **同期PRレビュー時の注意（巻き戻し検知）:** `CLAUDE.md`・`.ai-native/methodology/`・
> `.ai-native/guides/usage-guide.md` 等の共有ドキュメントは保護リストの対象外（同期で上書きされる）。
> このリポジトリ側で先行して改訂した内容（例: v1.12.0 のデプロイパイプライン統合）が
> 同期元に未反映の場合、同期PRに**逆差分（改訂の巻き戻し）**として現れる。
> 同期PRのレビューでは「既存ファイルの上書きが意図通りか」の確認時に、
> 最新の INDEX.md CHANGELOG と突き合わせて巻き戻しがないかを必ず確認すること。

### 2-4. デプロイパイプライン

[`deploy-guide.md`](deploy-guide.md) の手順に従い、PowerShell スクリプト
（`scripts/setup-deploy-secrets.ps1`）で repository secrets / variables を登録する。

---

## §3 ドキュメント整合性検証（validate-docs.sh）

`pr-checks.yml` は PR ごとに `scripts/validate-docs.sh` を実行し、以下を検証する。

| チェック | 内容 | 失敗時の対処 |
|---------|------|-------------|
| C-1 | 方法論ドキュメントのバージョン統一（VERSIONING_PROTOCOL） | 全 `.ai-native/methodology/**/*.md` のフロントマター `version` を揃える |
| C-2 | INDEX.md 参照ドキュメントの実在 | 参照の修正、またはドキュメントの追加 |
| C-3 | ガイド参照（`guides/*.md`）の実在 | 参照の修正、またはガイドの作成 |
| C-4 | シークレット混入（トークン・秘密鍵） | 該当値を repository secrets に移し、露出したトークンは発行元で無効化する |

ローカルでの事前実行（Push 前チェックに組み込むこと）:

```bash
bash scripts/validate-docs.sh
```

> **C-4 の許容リスト:** `.github/secret-scan-allow.txt` に列挙されたパスは
> NG ではなく WARN として扱われる。登録は「既知でありローテーション対応を追跡中」の
> ものに限定し、対応完了後は必ず削除する。新規検出の握りつぶしに使わないこと。

---

## §4 トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| label-setup が権限エラー | ワークフローの `permissions` 不足 | リポジトリ Settings → Actions → Workflow permissions を確認 |
| sync が認証エラー | `SYNC_REPO_TOKEN` 未登録・期限切れ | §2-3 の手順で再登録 |
| pr-checks の整合性検証が失敗 | ドキュメント間の不整合 | §3 の表に従い修正。ローカルで `bash scripts/validate-docs.sh` を実行して確認 |
| deploy が事前検証で失敗 | secrets / variables 未登録 | [`deploy-guide.md`](deploy-guide.md) §4 で登録 |
