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

warn_lark_auth_if_needed() {
  if is_lark_authenticated; then
    return 0
  fi
  if [ "${PUSH_REQUIRE_LARK_AUTH:-0}" = "1" ]; then
    die "lark-cli 未登录，请先执行 ./deploy.sh"
  fi
  log "WARN: 未检测到有效 user 登录态，将继续执行（当前默认按 bot 模式推送通常不受影响）。"
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

warn_lark_auth_if_needed

if [ -z "${SILICONFLOW_API_KEY:-}" ]; then
  die "缺少 SILICONFLOW_API_KEY，无法执行推送。"
fi

log "Running workflow once..."
npm run runner:once
log "Push completed."
