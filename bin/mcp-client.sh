#!/usr/bin/env bash
# MCP stdio↔HTTP bridge: forwards one JSON-RPC message per line from stdin
# to the shared Telegram MCP daemon and writes each response to stdout.
# Lazily spawns the daemon if it is not running. Concurrent wrappers are
# serialized through flock during the detect-and-spawn critical section
# ONLY — the lock is released before the proxy loop starts so long-running
# ask_user calls do not block a second wrapper from connecting.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_BIN="$SCRIPT_DIR/../build/index.js"
STATE_DIR="/tmp/mcp-communicator-telegram-${USER:-$(id -un)}"
PID_FILE="$STATE_DIR/server.pid"
PORT_FILE="$STATE_DIR/server.port"
LOG_FILE="$STATE_DIR/server.log"
LOCK_FILE="$STATE_DIR/spawn.lock"

# 0o700 state dir: server.log contains Telegram question/answer bodies, so on
# a multi-user host it must not be readable by peers. umask 077 also covers
# any files the daemon writes (server.pid, server.port) with 0o600.
umask 077
mkdir -p "$STATE_DIR"

ensure_daemon() {
  # Subshell scopes fd 200 (and therefore the flock) to the critical section.
  # When the subshell exits, the lock releases automatically.
  if ! (
    flock -x 200

    if [[ -f "$PID_FILE" ]]; then
      pid=$(cat "$PID_FILE")
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        exit 0   # daemon alive; nothing to do
      fi
      rm -f "$PID_FILE" "$PORT_FILE"
    fi

    # Close fd 200 for the daemon child so it does not inherit the lock fd
    # from our subshell and keep flock held forever. Close stdin (</dev/null)
    # so the daemon is not pinned to our pipe if CC exits.
    nohup node "$DAEMON_BIN" < /dev/null >> "$LOG_FILE" 2>&1 200>&- &
    disown

    # Wait up to 5s for the daemon to write its port file.
    for _ in $(seq 50); do
      if [[ -s "$PORT_FILE" ]]; then
        exit 0
      fi
      sleep 0.1
    done

    exit 1   # spawn timeout
  ) 200>"$LOCK_FILE"; then
    echo "[mcp-client] daemon failed to start; see $LOG_FILE" >&2
    exit 1
  fi
}

ensure_daemon
PORT=$(cat "$PORT_FILE")
[[ -n "$PORT" ]] || { echo "[mcp-client] empty $PORT_FILE after spawn" >&2; exit 1; }

# Proxy newline-delimited JSON-RPC on stdin to the daemon over HTTP.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  reply=$(
    printf '%s' "$line" \
    | curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
        -H 'Content-Type: application/json' \
        --data-binary @- \
        --max-time 0
  ) || {
    echo "[mcp-client] curl failed on request: $line" >&2
    continue
  }
  # Empty reply means the request was a JSON-RPC notification — no response.
  if [[ -n "$reply" ]]; then
    printf '%s\n' "$reply"
  fi
done
