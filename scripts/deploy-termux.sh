#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/chnsheg/WXClawBot.git}"
APP_DIR="${APP_DIR:-$HOME/apps/WXClawBot}"
DATA_DIR="${DATA_DIR:-$HOME/.wxclawbot/data}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/wxclawbot}"
SERVICE_NAME="${SERVICE_NAME:-wxclawbot}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.siliconflow.cn/v1}"
OPENAI_MODEL="${OPENAI_MODEL:-deepseek-ai/DeepSeek-V4-Flash}"
USER_NAME="${USER_NAME:-chensheng}"
USER_GENDER="${USER_GENDER:-male}"
RUN_LOGIN="${RUN_LOGIN:-1}"
OVERWRITE_ENV="${OVERWRITE_ENV:-0}"
BACKUP_DIR="${BACKUP_DIR:-}"

log() {
  printf '\n[termux-deploy] %s\n' "$*"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0'
}

install_packages() {
  log "Installing Termux packages."
  pkg update -y
  pkg install -y git curl nodejs-lts openssh termux-api tar

  local major
  major="$(node_major)"
  if [ "$major" -lt 22 ]; then
    log "nodejs-lts is older than 22. Trying nodejs package."
    pkg install -y nodejs
  fi

  major="$(node_major)"
  if [ "$major" -lt 22 ]; then
    printf 'Node.js 22+ is required, current version is %s.\n' "$(node -v 2>/dev/null || printf 'missing')" >&2
    exit 1
  fi
}

prepare_storage_paths() {
  if [ -z "$BACKUP_DIR" ]; then
    if [ ! -d "$HOME/storage/shared" ] && have_cmd termux-setup-storage; then
      log "Requesting Android shared storage permission for portable backups."
      termux-setup-storage || true
      sleep 3
    fi

    if [ -d "$HOME/storage/shared" ]; then
      BACKUP_DIR="$HOME/storage/shared/WXClawBot/backups"
    else
      BACKUP_DIR="$HOME/.wxclawbot/backups"
      log "Shared storage is not ready. Backups will use $BACKUP_DIR."
    fi
  fi

  mkdir -p "$DATA_DIR" "$CONFIG_DIR" "$BACKUP_DIR" "$(dirname "$APP_DIR")"
}

write_paths_file() {
  local paths_file="$CONFIG_DIR/paths.env"
  log "Writing fixed path config to $paths_file."
  {
    printf 'APP_DIR=%q\n' "$APP_DIR"
    printf 'DATA_DIR=%q\n' "$DATA_DIR"
    printf 'BACKUP_DIR=%q\n' "$BACKUP_DIR"
    printf 'CONFIG_DIR=%q\n' "$CONFIG_DIR"
    printf 'SERVICE_NAME=%q\n' "$SERVICE_NAME"
  } > "$paths_file"
}

clone_or_update_repo() {
  if [ -d "$APP_DIR/.git" ]; then
    log "Updating existing repo at $APP_DIR."
    git -C "$APP_DIR" pull --ff-only
    return
  fi

  if [ -e "$APP_DIR" ] && [ "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)" -gt 0 ]; then
    if [ -f "$APP_DIR/package.json" ]; then
      log "Using existing source checkout at $APP_DIR."
      return
    fi
    printf '%s exists and is not an empty WXClawBot checkout. Set APP_DIR to another path or clean it first.\n' "$APP_DIR" >&2
    exit 1
  fi

  log "Cloning $REPO_URL to $APP_DIR."
  git clone "$REPO_URL" "$APP_DIR"
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
  local env_file="$DATA_DIR/.env"
  if [ -f "$env_file" ] && [ "$OVERWRITE_ENV" != "1" ]; then
    log "$env_file already exists. Keeping it. Set OVERWRITE_ENV=1 to regenerate."
  else
    read_secret_if_needed
    log "Writing $env_file."
    umask 077
    cat > "$env_file" <<EOF
CYBERBOSS_USER_NAME=$USER_NAME
CYBERBOSS_USER_GENDER=$USER_GENDER
CYBERBOSS_STATE_DIR=$DATA_DIR
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
  fi

  link_env_file
}

link_env_file() {
  local app_env="$APP_DIR/.env"
  local env_file="$DATA_DIR/.env"
  if [ ! -f "$env_file" ] && [ -f "$app_env" ]; then
    log "Migrating existing $app_env to $env_file."
    cp "$app_env" "$env_file"
  fi
  if [ ! -f "$env_file" ]; then
    return
  fi

  if [ -L "$app_env" ] && [ "$(readlink "$app_env")" = "$env_file" ]; then
    return
  fi

  if [ -e "$app_env" ] || [ -L "$app_env" ]; then
    mv "$app_env" "$app_env.$(date +%Y%m%d-%H%M%S).bak"
  fi
  ln -s "$env_file" "$app_env" 2>/dev/null || cp "$env_file" "$app_env"
}

install_node_dependencies() {
  log "Installing npm dependencies."
  cd "$APP_DIR"
  npm install
}

install_control_scripts() {
  log "Installing Termux control commands."
  install -m 0755 "$APP_DIR/scripts/wxclawbot-termux.sh" "$PREFIX/bin/wxclawbot"
  cat > "$PREFIX/bin/wxclawbot-start" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
exec wxclawbot start "$@"
EOF
  cat > "$PREFIX/bin/wxclawbot-stop" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
exec wxclawbot stop "$@"
EOF
  cat > "$PREFIX/bin/wxclawbot-restart" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
exec wxclawbot restart "$@"
EOF
  chmod +x "$PREFIX/bin/wxclawbot-start" "$PREFIX/bin/wxclawbot-stop" "$PREFIX/bin/wxclawbot-restart"
}

login_wechat() {
  if [ "$RUN_LOGIN" != "1" ]; then
    log "Skipping WeChat login because RUN_LOGIN=$RUN_LOGIN."
    return
  fi
  log "Starting WeChat login. Use another device to scan the QR code, or scan a screenshot from WeChat album quickly."
  wxclawbot login
}

setup_pm2_and_boot() {
  if ! have_cmd pm2; then
    log "Installing pm2."
    npm install -g pm2
  fi

  log "Acquiring Termux wake lock."
  termux-wake-lock || true

  log "Starting $SERVICE_NAME with pm2."
  wxclawbot start

  log "Writing optional Termux:Boot script."
  mkdir -p "$HOME/.termux/boot"
  cat > "$HOME/.termux/boot/start-$SERVICE_NAME.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
wxclawbot start
EOF
  chmod +x "$HOME/.termux/boot/start-$SERVICE_NAME.sh"
}

main() {
  install_packages
  prepare_storage_paths
  clone_or_update_repo
  write_paths_file
  write_env_file
  install_node_dependencies
  install_control_scripts
  wxclawbot doctor >/dev/null
  login_wechat
  setup_pm2_and_boot
  log "Done. Use: wxclawbot status"
}

main "$@"
