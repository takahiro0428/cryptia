#!/usr/bin/env bash
# =============================================================================
# Firebase デプロイスクリプト（repository variable: DEPLOY_CMD から呼ばれる）
#
# 前提（repository secrets → deploy.yml が環境変数として注入）:
#   DEPLOY_TOKEN  = Firebase/GCP サービスアカウントの JSON キー（全文）
#   DEPLOY_TARGET = Firebase プロジェクト ID
# 任意（repository variables → ビルド時に Web アプリへ焼き込まれる公開設定）:
#   NUXT_PUBLIC_FIREBASE_API_KEY / NUXT_PUBLIC_FIREBASE_AUTH_DOMAIN /
#   NUXT_PUBLIC_FIREBASE_PROJECT_ID / NUXT_PUBLIC_FIREBASE_APP_ID
#   NUXT_VERTEX_LOCATION / NUXT_VERTEX_MODEL
#
# 処理: SA 認証準備 → Nuxt を firebase プリセットでビルド →
#       Functions 用 .env 生成 → hosting / functions / firestore:rules をデプロイ
# =============================================================================
set -euo pipefail

if [ -z "${DEPLOY_TOKEN:-}" ]; then
  echo "::error::DEPLOY_TOKEN（サービスアカウント JSON）が未設定です"
  exit 1
fi
if [ -z "${DEPLOY_TARGET:-}" ]; then
  echo "::error::DEPLOY_TARGET（Firebase プロジェクト ID）が未設定です"
  exit 1
fi

# --- サービスアカウント認証情報を一時ファイルへ（終了時に必ず削除） ---
SA_FILE="$(mktemp)"
trap 'rm -f "$SA_FILE"' EXIT
printf '%s' "$DEPLOY_TOKEN" > "$SA_FILE"
chmod 600 "$SA_FILE"
export GOOGLE_APPLICATION_CREDENTIALS="$SA_FILE"

# --- ビルド（SPA + Cloud Functions gen2） ---
echo "▶ Nuxt ビルド（NITRO_PRESET=firebase）"
(
  cd app
  export NITRO_PRESET=firebase
  # Vertex AI 用のプロジェクト ID はデプロイ先と同一（サーバー専用設定）
  export NUXT_GCP_PROJECT_ID="$DEPLOY_TARGET"
  pnpm run build
)

# --- Cloud Functions のランタイム環境変数（firebase-tools の dotenv 機構） ---
echo "▶ Functions ランタイム設定を生成"
{
  echo "NUXT_GCP_PROJECT_ID=$DEPLOY_TARGET"
  [ -n "${NUXT_VERTEX_LOCATION:-}" ] && echo "NUXT_VERTEX_LOCATION=$NUXT_VERTEX_LOCATION"
  [ -n "${NUXT_VERTEX_MODEL:-}" ] && echo "NUXT_VERTEX_MODEL=$NUXT_VERTEX_MODEL"
  # レートリミットの信頼プロキシホップ数（既定 1。Hosting CDN 経由で XFF に
  # ホップが加わる構成では 2 を設定。server/middleware/ai-rate-limit.ts 参照）
  [ -n "${NUXT_TRUSTED_PROXY_HOPS:-}" ] && echo "NUXT_TRUSTED_PROXY_HOPS=$NUXT_TRUSTED_PROXY_HOPS"
} > app/.output/server/.env

# --- デプロイ ---
# バージョンは完全固定する（SA キーを扱う環境でのサプライチェーン対策。
# 更新は PR レビュー経由で行うこと）
echo "▶ Firebase デプロイ（project: $DEPLOY_TARGET）"
npx --yes firebase-tools@14.27.0 deploy \
  --project "$DEPLOY_TARGET" \
  --only hosting,functions,firestore:rules \
  --non-interactive --force

echo "✅ デプロイ完了"
