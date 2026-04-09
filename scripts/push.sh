#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  echo "[push] $*"
}

die() {
  echo "[push] ERROR: $*" >&2
  exit 1
}

is_lark_authenticated() {
  local out
  out="$(lark-cli auth status 2>&1 || true)"
  if echo "$out" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    return 0
  fi
  if echo "$out" | grep -Eq '"tokenStatus"[[:space:]]*:[[:space:]]*"valid"'; then
    return 0
  fi
  if [ -f "${HOME}/.lark-cli/keychain.json" ] && grep -Eq '"(access_token|refresh_token)"[[:space:]]*:' "${HOME}/.lark-cli/keychain.json"; then
    return 0
  fi
  return 1
}

if [ ! -f ".env" ]; then
  if [ -f "config/.env.cn.example" ]; then
    cp config/.env.cn.example .env
  elif [ -f "config/.env.example" ]; then
    cp config/.env.example .env
  else
    die ".env 不存在且未找到配置模板。请先执行 ./deploy.sh"
  fi
  log ".env not found, copied from template."
fi

set -a
# shellcheck disable=SC1091
source ".env"
set +a

command -v node >/dev/null 2>&1 || die "Node.js 未安装，请先执行 ./deploy.sh"
command -v npm >/dev/null 2>&1 || die "npm 未安装，请先执行 ./deploy.sh"
command -v lark-cli >/dev/null 2>&1 || die "lark-cli 未安装，请先执行 ./deploy.sh"

is_lark_authenticated || die "lark-cli 未登录，请先执行 ./deploy.sh"

if [ -z "${SILICONFLOW_API_KEY:-}" ]; then
  die "缺少 SILICONFLOW_API_KEY，无法执行推送。"
fi

log "Running workflow once..."
npm run runner:once
log "Push completed."
