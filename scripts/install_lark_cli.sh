#!/usr/bin/env bash
set -euo pipefail

# Optional helper:
# Install lark-cli on host for troubleshooting, ID lookup, or ad-hoc operations.
# Production publish path is containerized lark-cli.

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "[lark-cli] Node.js/npm not found, installing via Homebrew..."
    brew install node
  else
    echo "[lark-cli] Node.js/npm not found. Please install Node.js 20+ first."
    exit 1
  fi
fi

echo "[lark-cli] Installing @larksuite/cli..."
npm install -g @larksuite/cli

echo "[lark-cli] Installing skills..."
npx skills add https://github.com/larksuite/cli -y -g

echo "[lark-cli] Starting app config init..."
lark-cli config init --new
