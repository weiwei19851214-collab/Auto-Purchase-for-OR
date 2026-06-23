#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${ENV_FILE:-$ROOT_DIR/.recharge.local.env}"
LEGACY_SKILL_PORT="${LEGACY_SKILL_PORT:-4100}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# 兼容旧 openrouter-recharge skill 的本地控制台端口。优先级：
# 1. PORT
# 2. OR_RUNNER_PORT / OPENROUTER_RECHARGE_PORT / RECHARGE_RUNNER_PORT
# 3. LEGACY_SKILL_PORT，默认 4100
export PORT="${PORT:-${OR_RUNNER_PORT:-${OPENROUTER_RECHARGE_PORT:-${RECHARGE_RUNNER_PORT:-$LEGACY_SKILL_PORT}}}}"
export OR_RUNNER_DB="${OR_RUNNER_DB:-$ROOT_DIR/data/runner.sqlite}"

mkdir -p "$ROOT_DIR/data/uploads" "$ROOT_DIR/data/results" "$ROOT_DIR/data/logs"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 未找到 node，请先安装 Node.js 22 或更高版本。" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "ERROR: 当前 Node.js 版本是 $(node -v)，本项目需要 Node.js 22 或更高版本。" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "提示: 未发现 node_modules。首次运行请先执行: npm install"
fi

stop_existing_port_owner() {
  if [[ "${SKIP_PORT_KILL:-}" == "1" ]]; then
    return
  fi
  if ! command -v lsof >/dev/null 2>&1; then
    echo "提示: 未找到 lsof，无法自动检查端口占用。"
    return
  fi

  local pids
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return
  fi

  echo "检测到端口 $PORT 已被占用，准备停止旧进程: $pids"
  for pid in $pids; do
    if [[ "$pid" == "$$" ]]; then
      continue
    fi
    kill "$pid" 2>/dev/null || true
  done

  for _ in {1..20}; do
    if [[ -z "$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ]]; then
      echo "端口 $PORT 已释放。"
      return
    fi
    sleep 0.25
  done

  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "旧进程未正常退出，强制停止: $pids"
    for pid in $pids; do
      if [[ "$pid" == "$$" ]]; then
        continue
      fi
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

stop_existing_port_owner

echo "OpenRouter 充值执行器本地启动"
echo "项目目录: $ROOT_DIR"
echo "兼容旧 skill 端口: $LEGACY_SKILL_PORT"
echo "访问地址: http://127.0.0.1:$PORT"
echo "数据库: $OR_RUNNER_DB"

if [[ -n "${OPOM_BASE_URL:-${OPOM_API_BASE:-}}" ]]; then
  echo "OPOM 地址: ${OPOM_BASE_URL:-$OPOM_API_BASE}"
else
  echo "OPOM 地址: 未配置，如需上线对接请在 .recharge.local.env 设置 OPOM_BASE_URL=http://20.2.209.2:3000"
fi

if [[ -n "${OPOM_RECHARGE_TOKEN:-}" ]]; then
  echo "OPOM Token: 已配置"
else
  echo "OPOM Token: 未配置，OPOM 读取/写回不可用"
fi

echo
exec npm start
