#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/chnsheg/WXClawBot.git}"
APP_DIR="${APP_DIR:-$HOME/WXClawBot}"
SERVICE_NAME="${SERVICE_NAME:-wxclawbot}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.siliconflow.cn/v1}"
OPENAI_MODEL="${OPENAI_MODEL:-deepseek-ai/DeepSeek-V4-Flash}"
USER_NAME="${USER_NAME:-chensheng}"
USER_GENDER="${USER_GENDER:-male}"
RUN_LOGIN="${RUN_LOGIN:-1}"
OVERWRITE_ENV="${OVERWRITE_ENV:-0}"

log() {
  printf '\n[deploy] %s\n' "$*"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0'
}

install_system_packages() {
  if have_cmd apt-get; then
    log "Installing base packages with apt."
    run_sudo apt-get update
    run_sudo apt-get install -y git curl ca-certificates build-essential
    return
  fi

  log "apt-get not found. Please install git, curl, build tools, and Node.js 22+ manually."
}

install_node_if_needed() {
  local major
  major="$(node_major)"
  if [ "$major" -ge 22 ]; then
    log "Node.js $(node -v) is ready."
    return
  fi

  if have_cmd apt-get; then
    log "Installing Node.js 22 from NodeSource."
    curl -fsSL https://deb.nodesource.com/setup_22.x | run_sudo bash -
    run_sudo apt-get install -y nodejs
  fi

  major="$(node_major)"
  if [ "$major" -lt 22 ]; then
    printf 'Node.js 22+ is required, current version is %s.\n' "$(node -v 2>/dev/null || printf 'missing')" >&2
    exit 1
  fi
}

clone_or_update_repo() {
  if [ -d "$APP_DIR/.git" ]; then
    log "Updating existing repo at $APP_DIR."
    git -C "$APP_DIR" pull --ff-only
  else
    log "Cloning $REPO_URL to $APP_DIR."
    git clone "$REPO_URL" "$APP_DIR"
  fi
}

read_secret_if_needed() {
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    return
  fi
  if [ -n "${CYBERBOSS_OPENAI_API_KEY:-}" ]; then
    OPENAI_API_KEY="$CYBERBOSS_OPENAI_API_KEY"
    return
  fi
  printf 'Enter SiliconFlow API key: '
  stty -echo
  read -r OPENAI_API_KEY
  stty echo
  printf '\n'
  if [ -z "$OPENAI_API_KEY" ]; then
    printf 'OPENAI_API_KEY is required.\n' >&2
    exit 1
  fi
}

write_env_file() {
  local env_file="$APP_DIR/.env"
  if [ -f "$env_file" ] && [ "$OVERWRITE_ENV" != "1" ]; then
    log ".env already exists. Keeping it. Set OVERWRITE_ENV=1 to regenerate."
    return
  fi

  read_secret_if_needed
  log "Writing $env_file."
  umask 077
  cat > "$env_file" <<EOF
CYBERBOSS_USER_NAME=$USER_NAME
CYBERBOSS_USER_GENDER=$USER_GENDER
CYBERBOSS_WORKSPACE_ROOT=$APP_DIR
CYBERBOSS_RUNTIME=openai
CYBERBOSS_OPENAI_BASE_URL=$OPENAI_BASE_URL
CYBERBOSS_OPENAI_API_KEY=$OPENAI_API_KEY
CYBERBOSS_OPENAI_MODEL=$OPENAI_MODEL
CYBERBOSS_OPENAI_CONTEXT_WINDOW=1000000
CYBERBOSS_OPENAI_TIMEOUT_MS=120000
CYBERBOSS_OPENAI_MAX_TOOL_CALLS=6
CYBERBOSS_OPENAI_ENABLE_TOOLS=true
CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS=20
EOF
}

install_node_dependencies() {
  log "Installing npm dependencies."
  cd "$APP_DIR"
  npm install
}

login_wechat() {
  if [ "$RUN_LOGIN" != "1" ]; then
    log "Skipping WeChat login because RUN_LOGIN=$RUN_LOGIN."
    return
  fi
  log "Starting WeChat login. Scan the QR code when it appears."
  cd "$APP_DIR"
  npm run login
}

start_with_pm2() {
  if ! have_cmd pm2; then
    log "Installing pm2."
    npm install -g pm2
  fi

  log "Starting $SERVICE_NAME with pm2."
  cd "$APP_DIR"
  pm2 delete "$SERVICE_NAME" >/dev/null 2>&1 || true
  pm2 start ./bin/cyberboss.js --name "$SERVICE_NAME" -- start --checkin
  pm2 save

  if have_cmd systemctl; then
    log "Configuring pm2 startup. You may be asked for sudo."
    pm2 startup systemd -u "$USER" --hp "$HOME" || true
    pm2 save
  fi
}

main() {
  install_system_packages
  install_node_if_needed
  clone_or_update_repo
  write_env_file
  install_node_dependencies
  cd "$APP_DIR"
  npm run doctor >/dev/null
  login_wechat
  start_with_pm2
  log "Done. Use: pm2 logs $SERVICE_NAME"
}

main "$@"
