#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/weiwei19851214-collab/Auto-Purchase-for-OR}"
BRANCH="${BRANCH:-new-portal}"
INSTALL_ROOT="${INSTALL_ROOT:-$HOME/OpenRouter-Recharge-Runner}"
PROJECT_DIR="$INSTALL_ROOT/Auto-Purchase-for-OR"

configure_homebrew_path() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_homebrew() {
  configure_homebrew_path
  if command -v brew >/dev/null 2>&1; then
    return
  fi

  echo "Homebrew is required. Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  configure_homebrew_path
  if ! command -v brew >/dev/null 2>&1; then
    echo "ERROR: Homebrew installation completed, but brew is not available in this shell." >&2
    echo "Close this Terminal window and run this script again." >&2
    exit 1
  fi
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "0"
    return
  fi
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0"
}

ensure_git_and_node() {
  ensure_homebrew
  if ! command -v git >/dev/null 2>&1; then
    echo "Installing Git..."
    brew install git
  fi

  local node_major
  node_major="$(node_major_version)"
  if [[ "$node_major" -lt 22 ]]; then
    echo "Installing Node.js LTS..."
    brew install node
    export PATH="$(brew --prefix node)/bin:$PATH"
    node_major="$(node_major_version)"
  fi
  if [[ "$node_major" -lt 22 ]]; then
    echo "ERROR: Node.js 22 or later is required." >&2
    exit 1
  fi
}

clone_if_missing() {
  if [[ -e "$PROJECT_DIR" ]]; then
    if [[ ! -d "$PROJECT_DIR/.git" ]]; then
      echo "ERROR: Install path already exists but is not a Git repository: $PROJECT_DIR" >&2
      exit 1
    fi
    echo "Using existing project: $PROJECT_DIR"
    return
  fi

  mkdir -p "$INSTALL_ROOT"
  echo "Cloning branch $BRANCH..."
  git clone --branch "$BRANCH" --single-branch "$REPOSITORY_URL" "$PROJECT_DIR"
}

port="${PORT:-${OR_RUNNER_PORT:-${OPENROUTER_RECHARGE_PORT:-${RECHARGE_RUNNER_PORT:-4100}}}}"
export PORT="$port"

ensure_git_and_node
clone_if_missing

if [[ ! -x "$PROJECT_DIR/start-local.sh" ]]; then
  echo "ERROR: The cloned branch does not contain start-local.sh: $BRANCH" >&2
  exit 1
fi

echo "Starting project at $PROJECT_DIR"
"$PROJECT_DIR/start-local.sh" &
launcher_pid=$!
health_url="http://127.0.0.1:$PORT/api/health"
console_url="http://127.0.0.1:$PORT"

for _ in {1..30}; do
  sleep 1
  if curl --fail --silent --show-error --max-time 2 "$health_url" >/dev/null 2>&1; then
    echo "Opening $console_url"
    open "$console_url"
    wait "$launcher_pid"
    exit $?
  fi
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    wait "$launcher_pid"
  fi
done

echo "ERROR: The local console did not become ready at $console_url." >&2
echo "Check the Terminal output above for the startup error." >&2
kill "$launcher_pid" 2>/dev/null || true
exit 1
