#!/usr/bin/env bash
# =============================================================================
# ドキュメント整合性検証スクリプト
#
# AIネイティブ開発方法論リポジトリの「単体テスト」に相当する静的検証。
# CI（.github/workflows/pr-checks.yml）およびローカルで実行できる。
#
#   実行方法: bash scripts/validate-docs.sh
#   終了コード: 0 = 全チェック PASS / 1 = 1件以上の NG あり
#
# チェック内容:
#   C-1 方法論ドキュメントのフロントマターバージョン統一
#       （INDEX.md VERSIONING_PROTOCOL「バージョン統一ルール」の機械検証）
#   C-2 INDEX.md が参照する方法論ドキュメントの実在確認
#   C-3 ガイド間クロスリファレンス（guides/*.md 参照）の実在確認
#   C-4 シークレット（トークン・秘密鍵等）のコミット混入検査
# =============================================================================
set -u

# リポジトリルートへ移動（スクリプトの位置から解決）
cd "$(dirname "$0")/.." || exit 1

ERRORS=0

ng() {
  # GitHub Actions 上ではエラーアノテーションとしても出力する
  echo "::error::${1}"
  echo "  NG: ${1}"
  ERRORS=$((ERRORS + 1))
}

ok() {
  echo "  OK: ${1}"
}

# -----------------------------------------------------------------------------
# C-1: 方法論ドキュメントのフロントマターバージョン統一
# -----------------------------------------------------------------------------
echo "[C-1] 方法論ドキュメントのバージョン統一チェック"

version_list=""
while IFS= read -r file; do
  v=$(head -10 "$file" | grep -m1 '^version:' | awk '{print $2}')
  if [ -z "$v" ]; then
    ng "フロントマターに version がありません: ${file}"
  else
    version_list="${version_list}${file}=${v}\n"
  fi
done < <(find .ai-native/methodology -name '*.md' | sort)

unique_versions=$(printf '%b' "$version_list" | awk -F= 'NF{print $2}' | sort -u)
version_count=$(echo "$unique_versions" | grep -c . || true)

if [ "$version_count" -eq 1 ]; then
  ok "全方法論ドキュメントが version ${unique_versions} に統一されています"
elif [ "$version_count" -gt 1 ]; then
  ng "バージョンが統一されていません（VERSIONING_PROTOCOL 違反）: $(echo "$unique_versions" | tr '\n' ' ')"
  printf '%b' "$version_list" | awk -F= 'NF{printf "      %s → %s\n", $1, $2}'
else
  # 検証対象が1件も見つからない場合はフェイルクローズ（無言の PASS を許さない）
  ng "検証対象の方法論ドキュメントが1件も見つかりません（.ai-native/methodology/ の存在を確認してください）"
fi

# -----------------------------------------------------------------------------
# C-2: INDEX.md が参照する方法論ドキュメントの実在確認
# -----------------------------------------------------------------------------
echo "[C-2] INDEX.md 参照ドキュメントの実在チェック"

if [ ! -f .ai-native/methodology/INDEX.md ]; then
  # INDEX 自体の不在もフェイルクローズ
  ng "INDEX.md が存在しません: .ai-native/methodology/INDEX.md"
else
  missing=0
  while IFS= read -r ref; do
    if [ ! -f ".ai-native/methodology/${ref}" ]; then
      ng "INDEX.md が参照するドキュメントが存在しません: .ai-native/methodology/${ref}"
      missing=$((missing + 1))
    fi
  done < <(grep -oE '(common|roles|templates)/[a-z0-9-]+\.md' .ai-native/methodology/INDEX.md | sort -u)

  [ "$missing" -eq 0 ] && ok "INDEX.md の参照ドキュメントはすべて実在します"
fi

# -----------------------------------------------------------------------------
# C-3: ガイド間クロスリファレンスの実在確認
# -----------------------------------------------------------------------------
echo "[C-3] ガイド参照（guides/*.md）の実在チェック"

missing=0
while IFS= read -r ref; do
  name="${ref#guides/}"
  if [ ! -f ".ai-native/guides/${name}" ]; then
    ng "参照されているガイドが存在しません: .ai-native/guides/${name}"
    missing=$((missing + 1))
  fi
done < <(grep -rhoE 'guides/[a-z0-9-]+\.md' --include='*.md' .ai-native CLAUDE.md README.md 2>/dev/null | sort -u)

[ "$missing" -eq 0 ] && ok "参照されているガイドはすべて実在します"

# -----------------------------------------------------------------------------
# C-4: シークレット混入検査
# -----------------------------------------------------------------------------
# 検出パターン: GitHub トークン / AWSアクセスキー / Google APIキー / 秘密鍵ヘッダ
# 許容リスト: .github/secret-scan-allow.txt に列挙されたパス（既知・対応追跡中のもの）
echo "[C-4] シークレット混入チェック"

SECRET_PATTERNS='ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
ALLOWLIST_FILE=".github/secret-scan-allow.txt"

hits=$(grep -rIlE "$SECRET_PATTERNS" . \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude="$(basename "$0")" \
  --exclude="secret-scan-allow.txt" \
  2>/dev/null || true)

found=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  hit_path="${hit#./}"
  if [ -f "$ALLOWLIST_FILE" ] && grep -qxF "$hit_path" <(grep -vE '^\s*(#|$)' "$ALLOWLIST_FILE"); then
    echo "  WARN: ${hit_path} にシークレットらしき文字列（許容リスト登録済み・要ローテーション追跡）"
  else
    ng "シークレットらしき文字列が含まれています: ${hit_path}（repository secrets に移し、コミット履歴からの失効処理を行うこと）"
    found=$((found + 1))
  fi
done <<< "$hits"

[ "$found" -eq 0 ] && ok "許容リスト外のシークレット混入はありません"

# -----------------------------------------------------------------------------
# 結果サマリー
# -----------------------------------------------------------------------------
echo "----------------------------------------"
if [ "$ERRORS" -eq 0 ]; then
  echo "検証結果: PASS（NG 0件）"
  exit 0
else
  echo "検証結果: FAIL（NG ${ERRORS}件）— 上記の NG をすべて解消してください"
  exit 1
fi
