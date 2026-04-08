#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f ".env" ]; then
  if [ -f ".env.cn.example" ]; then
    cp .env.cn.example .env
  else
    cp .env.example .env
  fi
  echo "[run_full_push] .env not found, copied from template."
fi

if [ -z "${SILICONFLOW_API_KEY:-}" ] && ! grep -q '^SILICONFLOW_API_KEY=' .env; then
  echo "[run_full_push] Missing SILICONFLOW_API_KEY in environment or .env"
  exit 1
fi

echo "[run_full_push] Installing dependencies..."
npm install

echo "[run_full_push] Building TypeScript..."
npm run build

echo "[run_full_push] Running full workflow once..."
npm run runner:once

echo "[run_full_push] Completed successfully."
