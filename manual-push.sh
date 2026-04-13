#!/usr/bin/env bash
# manual-push.sh — 手动推送脚本
# 用法：
#   ./manual-push.sh --days 7            推送最近 7 天的论文
#   ./manual-push.sh --days 3 --dry-run  推送最近 3 天的论文（仅生成文件）

set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd || true)"
ROOT_DIR="$SCRIPT_DIR"
cd "$ROOT_DIR"

DRY_RUN=0
DAYS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)
      DAYS="$2"
      shift 2
      ;;
    --dry-run|--dryrun)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      echo "Usage: ./manual-push.sh --days N [options]"
      echo ""
      echo "Required:"
      echo "  --days N             指定推送最近 N 天的论文（必填）"
      echo ""
      echo "Options:"
      echo "  --dry-run, --dryrun  仅生成 md/json 文件，跳过飞书发布"
      echo "  -h, --help           显示帮助"
      echo ""
      echo "示例："
      echo "  ./manual-push.sh --days 7            # 推送最近 7 天"
      echo "  ./manual-push.sh --days 3 --dry-run  # 推送最近 3 天（dry-run）"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run './manual-push.sh --help' for usage."
      exit 1
      ;;
  esac
done

if [ -z "$DAYS" ]; then
  echo "ERROR: --days N is required."
  echo "Run './manual-push.sh --help' for usage."
  exit 1
fi

if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || [ "$DAYS" -le 0 ]; then
  echo "ERROR: --days must be a positive integer."
  exit 1
fi

log() {
  echo "[manual-push] $*"
}

die() {
  echo "[manual-push] ERROR: $*" >&2
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

# 设置手动推送模式和天数
export PUSH_MODE=manual
export PUSH_DAYS="$DAYS"

log "手动推送模式：推送最近 ${DAYS} 天的论文"

if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN 模式：跳过 lark-cli 检查，仅生成 md/json 文件"
  log "Running workflow (manual mode, ${DAYS} days, dry-run)..."
  PUSH_DRY_RUN=1 npm run runner:once
  log "Dry-run completed. 产物保存在 data/feishu-publisher/"
else
  command -v lark-cli >/dev/null 2>&1 || die "lark-cli 未安装，请先执行 ./deploy.sh"
  warn_lark_auth_if_needed

  if [ -z "${SILICONFLOW_API_KEY:-}" ]; then
    die "缺少 SILICONFLOW_API_KEY，无法执行推送。"
  fi

  log "Running workflow (manual mode, ${DAYS} days)..."
  npm run runner:once
  log "Manual push completed."
fi
