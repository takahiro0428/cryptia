#!/usr/bin/env bash
# =============================================================================
# CI 環境セットアップ（repository variable: SETUP_CMD から呼ばれる）
# デプロイパイプライン（.github/workflows/deploy.yml）のテスト・デプロイ両ジョブで
# 使用する。pnpm の導入と依存関係のインストールを行う。
# 冪等: 何度実行しても安全。
# =============================================================================
set -euo pipefail

echo "▶ pnpm セットアップ"
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@10
fi
pnpm --version

echo "▶ アプリ依存関係のインストール"
cd app
pnpm install --frozen-lockfile
