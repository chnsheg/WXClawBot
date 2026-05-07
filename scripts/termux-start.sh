#!/data/data/com.termux/files/usr/bin/bash
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/wxclawbot-termux.sh" start "$@"
