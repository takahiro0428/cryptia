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
#   NUXT_VERTEX_LOCATION / NUXT_VERTEX_MODEL / NUXT_TRUSTED_PROXY_HOPS
#   FIREBASE_HOSTING_SITE   = デプロイ先 Hosting サイト名（共有プロジェクトで
#                             他アプリと同居する場合は専用サイトを指定。
#                             未設定時はプロジェクト既定サイト = プロジェクト ID）
#   DEPLOY_FIRESTORE_RULES  = 'true' で firestore.rules もデプロイする。
#                             ルールは専用データベース "cryptia" のみに適用されるため
#                             共有プロジェクトでも安全。ただし事前にデータベースの
#                             作成が必要（firestore.rules 冒頭の作成コマンド参照）
#
# 【共有プロジェクトでの同居対策】
#   - Functions は codebase "cryptia"（firebase.json）に限定してデプロイするため、
#     他アプリの関数には触れない（削除もされない）
#   - 関数名は cryptiaserver（nuxt.config.ts の serverFunctionName）
#   - Hosting は target "cryptia" を FIREBASE_HOSTING_SITE へバインドしてデプロイ
#   - Firestore は専用の名前付きデータベース "cryptia" を使用（ルール・データとも分離）
#
# 処理: SA 認証準備 → Nuxt を firebase プリセットでビルド →
#       Functions 用 .env 生成 → hosting:cryptia / functions:cryptia（+ 任意で rules）をデプロイ
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

# --- Functions ソースの依存関係インストール ---
# firebase-tools はデプロイ前にソースをローカルへロードしてトリガーを解析するため、
# .output/server（Nitro 生成の package.json）に node_modules が必要。
# これがないと「Cannot find package 'firebase-functions'」でデプロイが失敗する。
echo "▶ Functions 依存関係のインストール（トリガー解析用）"
(
  cd app/.output/server
  npm install --omit=dev --no-audit --no-fund
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
  # 'true' で AI API を認証必須化（未認証 401。既定は匿名許可 + 低レート枠）
  [ -n "${NUXT_AI_REQUIRE_AUTH:-}" ] && echo "NUXT_AI_REQUIRE_AUTH=$NUXT_AI_REQUIRE_AUTH"
} > app/.output/server/.env

# --- デプロイ ---
# バージョンは完全固定する（SA キーを扱う環境でのサプライチェーン対策。
# 更新は PR レビュー経由で行うこと）
FIREBASE_CLI="firebase-tools@14.27.0"

# Hosting target を実サイトへバインド（共有プロジェクトの複数サイト同居対応）
HOSTING_SITE="${FIREBASE_HOSTING_SITE:-$DEPLOY_TARGET}"
echo "▶ Hosting target を適用（site: $HOSTING_SITE）"
npx --yes "$FIREBASE_CLI" target:apply hosting cryptia "$HOSTING_SITE" \
  --project "$DEPLOY_TARGET"

# デプロイ対象は本アプリのリソースに限定する（他アプリの hosting/functions に触れない）
DEPLOY_ONLY="hosting:cryptia,functions:cryptia"
if [ "${DEPLOY_FIRESTORE_RULES:-}" = "true" ]; then
  echo "▶ firestore.rules もデプロイします（専用データベース cryptia のみに適用。要: DB 作成済み）"
  DEPLOY_ONLY="$DEPLOY_ONLY,firestore"
fi

echo "▶ Firebase デプロイ（project: $DEPLOY_TARGET / only: $DEPLOY_ONLY）"
npx --yes "$FIREBASE_CLI" deploy \
  --project "$DEPLOY_TARGET" \
  --only "$DEPLOY_ONLY" \
  --non-interactive --force

echo "✅ デプロイ完了"
