#!/usr/bin/env bash
# push.sh — 日常推送脚本
# 用法：
#   ./push.sh            正式推送（抓取 + 增强 + 发布到飞书）
#   ./push.sh --dry-run 仅生成 md/json 文件，不发布到飞书

set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd || true)"
ROOT_DIR="$SCRIPT_DIR"
cd "$ROOT_DIR"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|--dryrun)
      DRY_RUN=1
      ;;
    -h|--help)
      echo "Usage: ./push.sh [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run, --dryrun  仅生成 md/json 文件，跳过飞书发布"
      echo "  -h, --help           显示帮助"
      exit 0
      ;;
  esac
done

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

if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN 模式：跳过 lark-cli 检查，仅生成 md/json 文件"
  log "Running workflow (dry-run)..."
  PUSH_DRY_RUN=1 npm run runner:once
  log "Dry-run completed. 产物保存在 data/feishu-publisher/"
else
  command -v lark-cli >/dev/null 2>&1 || die "lark-cli 未安装，请先执行 ./deploy.sh"
  warn_lark_auth_if_needed

  if [ -z "${SILICONFLOW_API_KEY:-}" ]; then
    die "缺少 SILICONFLOW_API_KEY，无法执行推送。"
  fi

  log "Running workflow..."
  npm run runner:once
  log "Push completed."
fi
