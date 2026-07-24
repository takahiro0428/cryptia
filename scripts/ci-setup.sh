#!/usr/bin/env bash
# =============================================================================
# CI 環境セットアップ（repository variable: SETUP_CMD から呼ばれる）
# デプロイパイプライン（.github/workflows/deploy.yml）のテスト・デプロイ両ジョブで
# 使用する。pnpm の導入と依存関係のインストールを行う。
# 冪等: 何度実行しても安全。
# =============================================================================
set -euo pipefail

echo "▶ pnpm セットアップ"
# バージョンは完全固定（サプライチェーン対策。更新は PR レビュー経由で行う）
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@10.34.5
fi
pnpm --version

echo "▶ アプリ依存関係のインストール"
cd app
pnpm install --frozen-lockfile
