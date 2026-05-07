#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

DEFAULT_APP_DIR="$HOME/apps/WXClawBot"
DEFAULT_DATA_DIR="$HOME/.wxclawbot/data"
DEFAULT_CONFIG_DIR="$HOME/.config/wxclawbot"
DEFAULT_SHARED_BACKUP_DIR="$HOME/storage/shared/WXClawBot/backups"
DEFAULT_PRIVATE_BACKUP_DIR="$HOME/.wxclawbot/backups"

CONFIG_DIR="${WXCLAWBOT_CONFIG_DIR:-$DEFAULT_CONFIG_DIR}"
PATHS_FILE="${WXCLAWBOT_PATHS_FILE:-$CONFIG_DIR/paths.env}"

APP_DIR="${APP_DIR:-$DEFAULT_APP_DIR}"
DATA_DIR="${DATA_DIR:-$DEFAULT_DATA_DIR}"
BACKUP_DIR="${BACKUP_DIR:-}"
SERVICE_NAME="${SERVICE_NAME:-wxclawbot}"

if [ -f "$PATHS_FILE" ]; then
  # shellcheck source=/dev/null
  . "$PATHS_FILE"
fi

if [ -z "${BACKUP_DIR:-}" ]; then
  if [ -d "$HOME/storage/shared" ]; then
    BACKUP_DIR="$DEFAULT_SHARED_BACKUP_DIR"
  else
    BACKUP_DIR="$DEFAULT_PRIVATE_BACKUP_DIR"
  fi
fi

log() {
  printf '[wxclawbot] %s\n' "$*"
}

die() {
  printf '[wxclawbot] %s\n' "$*" >&2
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_app() {
  [ -d "$APP_DIR" ] || die "APP_DIR not found: $APP_DIR. Run deploy-termux.sh first."
  [ -f "$APP_DIR/package.json" ] || die "package.json not found in APP_DIR: $APP_DIR"
}

ensure_dirs() {
  mkdir -p "$DATA_DIR" "$BACKUP_DIR" "$CONFIG_DIR"
}

ensure_pm2() {
  if ! have_cmd pm2; then
    log "Installing pm2."
    npm install -g pm2
  fi
}

export_runtime_env() {
  export CYBERBOSS_STATE_DIR="$DATA_DIR"
  export CYBERBOSS_WORKSPACE_ROOT="$APP_DIR"
  export CYBERBOSS_HOME="$APP_DIR"
}

pm2_has_service() {
  pm2 describe "$SERVICE_NAME" >/dev/null 2>&1
}

start_service() {
  ensure_app
  ensure_dirs
  ensure_pm2
  termux-wake-lock >/dev/null 2>&1 || true
  cd "$APP_DIR"
  export_runtime_env
  if pm2_has_service; then
    pm2 restart "$SERVICE_NAME" --update-env
  else
    pm2 start node --name "$SERVICE_NAME" -- ./bin/cyberboss.js start --checkin
  fi
  pm2 save
  log "Started $SERVICE_NAME."
}

stop_service() {
  ensure_pm2
  if pm2_has_service; then
    pm2 stop "$SERVICE_NAME"
    pm2 save
    log "Stopped $SERVICE_NAME."
  else
    log "$SERVICE_NAME is not registered in pm2."
  fi
  termux-wake-unlock >/dev/null 2>&1 || true
}

restart_service() {
  ensure_app
  ensure_dirs
  ensure_pm2
  cd "$APP_DIR"
  export_runtime_env
  if pm2_has_service; then
    pm2 restart "$SERVICE_NAME" --update-env
  else
    start_service
    return
  fi
  pm2 save
  log "Restarted $SERVICE_NAME."
}

show_status() {
  ensure_pm2
  pm2 status
  show_paths
}

show_logs() {
  ensure_pm2
  local lines="${1:-120}"
  pm2 logs "$SERVICE_NAME" --lines "$lines"
}

run_login() {
  ensure_app
  ensure_dirs
  cd "$APP_DIR"
  export_runtime_env
  npm run login
}

run_doctor() {
  ensure_app
  ensure_dirs
  cd "$APP_DIR"
  export_runtime_env
  npm run doctor
}

update_app() {
  ensure_app
  git -C "$APP_DIR" pull --ff-only
  cd "$APP_DIR"
  npm install
  install_self
  restart_service
}

install_self() {
  ensure_app
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
  log "Installed wxclawbot commands into $PREFIX/bin."
}

create_backup() {
  ensure_dirs
  local stamp
  local output
  local tmpdir
  stamp="$(date +%Y%m%d-%H%M%S)"
  output="${1:-$BACKUP_DIR/wxclawbot-data-$stamp.tar.gz}"
  mkdir -p "$(dirname "$output")"
  tmpdir="$(mktemp -d)"
  cp -a "$DATA_DIR" "$tmpdir/data"
  if [ -f "$PATHS_FILE" ]; then
    cp "$PATHS_FILE" "$tmpdir/paths.env"
  fi
  tar -czf "$output" -C "$tmpdir" .
  rm -rf "$tmpdir"
  log "Backup written: $output"
}

restore_backup() {
  local archive="${1:-}"
  [ -n "$archive" ] || die "Usage: wxclawbot restore /path/to/wxclawbot-data.tar.gz"
  [ -f "$archive" ] || die "Backup not found: $archive"
  ensure_dirs
  local tmpdir
  tmpdir="$(mktemp -d)"
  tar -xzf "$archive" -C "$tmpdir"
  if [ -d "$tmpdir/data" ]; then
    cp -a "$tmpdir/data/." "$DATA_DIR/"
  else
    die "Backup archive does not contain a data directory."
  fi
  rm -rf "$tmpdir"
  log "Backup restored into $DATA_DIR."
  log "Run 'wxclawbot restart' after restore."
}

show_paths() {
  printf '\n[wxclawbot paths]\n'
  printf 'APP_DIR=%s\n' "$APP_DIR"
  printf 'DATA_DIR=%s\n' "$DATA_DIR"
  printf 'BACKUP_DIR=%s\n' "$BACKUP_DIR"
  printf 'CONFIG_DIR=%s\n' "$CONFIG_DIR"
  printf 'SERVICE_NAME=%s\n' "$SERVICE_NAME"
}

print_help() {
  cat <<'EOF'
Usage: wxclawbot <command>

Commands:
  start              Start WXClawBot with pm2 and check-in polling
  stop               Stop WXClawBot and release Termux wake lock
  restart            Restart WXClawBot
  status             Show pm2 status and fixed paths
  logs [lines]        Show service logs
  login              Start WeChat QR login
  doctor             Run project diagnostics
  update             Pull latest code, install dependencies, restart
  backup [file]       Export data, threads, reminders, diary, stickers, and config
  restore <file>      Restore a backup archive into DATA_DIR
  paths              Print fixed storage paths
  install            Reinstall wxclawbot control commands
EOF
}

command="${1:-help}"
shift || true

case "$command" in
  start) start_service "$@" ;;
  stop) stop_service "$@" ;;
  restart) restart_service "$@" ;;
  status) show_status "$@" ;;
  logs) show_logs "$@" ;;
  login) run_login "$@" ;;
  doctor) run_doctor "$@" ;;
  update) update_app "$@" ;;
  backup) create_backup "$@" ;;
  restore) restore_backup "$@" ;;
  paths) show_paths "$@" ;;
  install) install_self "$@" ;;
  help|--help|-h) print_help ;;
  *) die "Unknown command: $command. Run: wxclawbot help" ;;
esac
