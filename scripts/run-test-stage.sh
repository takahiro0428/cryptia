#!/usr/bin/env bash
# =============================================================================
# デプロイパイプライン ステージ実行スクリプト
#
# GitHub Actions（.github/workflows/deploy.yml）の各ステージ（単体テスト・
# 結合テスト・シナリオテスト・デプロイ）から呼び出される共通実行ラッパー。
#
#   使い方:
#     STAGE_CMD="npm run test:unit" bash scripts/run-test-stage.sh "単体テスト" unit-test
#
#   引数:
#     $1 = ステージ表示名（例: 単体テスト）
#     $2 = ログファイル名（拡張子なし。例: unit-test）
#   環境変数:
#     STAGE_CMD          = 実行するコマンド（repository variables から注入される）
#     ARTIFACT_NAME      = ログのアップロード先アーティファクト名（既定: deploy-logs。
#                          deploy ジョブでは deploy-execution-logs を指定する）
#     SCRUB_SECRET_NAMES = ログ・サマリー保存前に値を除去する環境変数名の
#                          スペース区切りリスト（既定: DEPLOY_TOKEN DEPLOY_TARGET）
#
# 失敗時の挙動（デプロイ中断の根拠ログを必ず残す）:
#   - 終了コード・実行コマンド・ログ末尾を GITHUB_STEP_SUMMARY に記録
#   - ::error:: アノテーションを出力
#   - 全ログを .deploy-logs/ に保存（ワークフロー側でアーティファクト化）
#   - 非ゼロ終了 → 後続ステージ（最終的にデプロイ）は実行されない
#
# 機密値の保護:
#   GitHub のシークレットマスキングはストリームログにのみ適用され、
#   アーティファクトファイルや Step Summary の内容には適用されない。
#   そのため SCRUB_SECRET_NAMES に列挙された環境変数の値を、
#   ログファイル・サマリーへの保存前に *** へ置換する。
# =============================================================================
set -u

STAGE_NAME="${1:?ステージ表示名を指定してください}"
LOG_NAME="${2:?ログファイル名を指定してください}"
LOG_DIR=".deploy-logs"
LOG_FILE="${LOG_DIR}/${LOG_NAME}.log"
ARTIFACT_NAME="${ARTIFACT_NAME:-deploy-logs}"

if [ -z "${STAGE_CMD:-}" ]; then
  echo "::error::${STAGE_NAME} の実行コマンド（STAGE_CMD）が設定されていません。repository variables を確認してください。"
  exit 1
fi

# SCRUB_SECRET_NAMES に列挙された環境変数の値を *** に置換する
scrub_secrets() {
  local text="$1" name value
  for name in ${SCRUB_SECRET_NAMES:-DEPLOY_TOKEN DEPLOY_TARGET}; do
    value="${!name-}"
    if [ -n "$value" ]; then
      text="${text//"$value"/***}"
    fi
  done
  printf '%s' "$text"
}

mkdir -p "$LOG_DIR"

SAFE_CMD="$(scrub_secrets "$STAGE_CMD")"
echo "▶ ${STAGE_NAME} 開始"
echo "  実行コマンド: ${SAFE_CMD}"

set -o pipefail
bash -e -c "$STAGE_CMD" 2>&1 | tee "$LOG_FILE"
exit_code=$?

# アーティファクト保存前にログファイルから機密値を除去する。
# 必ず先に変数へ読み込むこと: 複合コマンドへのリダイレクトは内部の
# コマンド置換より先にファイルを truncate するため、
# `{ ... "$(cat "$F")"; } > "$F"` の形はログを全損させる。
log_content="$(cat "$LOG_FILE")"
{ scrub_secrets "$log_content"; echo; } > "$LOG_FILE"

if [ "$exit_code" -eq 0 ]; then
  echo "✅ ${STAGE_NAME} 成功"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "- ✅ **${STAGE_NAME}**: 成功" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
else
  echo "❌ ${STAGE_NAME} 失敗（exit ${exit_code}）"

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "## ❌ ${STAGE_NAME} 失敗 — デプロイを中断します"
      echo ""
      echo "| 項目 | 内容 |"
      echo "|------|------|"
      echo "| ステージ | ${STAGE_NAME} |"
      echo "| 終了コード | ${exit_code} |"
      echo "| 完全なログ | アーティファクト \`${ARTIFACT_NAME}\` 内 \`${LOG_NAME}.log\` |"
      echo ""
      echo "**実行コマンド:**"
      echo ""
      echo '~~~~'
      echo "${SAFE_CMD}"
      echo '~~~~'
      echo ""
      echo "<details><summary>ログ末尾50行（何がどのように失敗したか）</summary>"
      echo ""
      echo '~~~~'
      tail -50 "$LOG_FILE"
      echo '~~~~'
      echo "</details>"
      echo ""
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  echo "::error::${STAGE_NAME} が失敗しました（exit ${exit_code}）。デプロイは中断されます。詳細は Step Summary とアーティファクト ${ARTIFACT_NAME} 内 ${LOG_NAME}.log を参照してください。"
  exit "$exit_code"
fi
