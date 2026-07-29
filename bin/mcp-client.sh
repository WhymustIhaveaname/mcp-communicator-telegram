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
ENV_FILE="$SCRIPT_DIR/../.env"

# Match the daemon's STATE_DIR keying: sha256(TELEGRAM_TOKEN) suffix lets
# different bots coexist and identical bots (any chat id) share one daemon.
INSTANCE_HASH=$(
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE" >/dev/null 2>&1 || true
  printf '%s' "${TELEGRAM_TOKEN:-}" | sha256sum | cut -c1-8
)
if [[ -z "$INSTANCE_HASH" || "$INSTANCE_HASH" == "$(printf '' | sha256sum | cut -c1-8)" ]]; then
  echo "[mcp-client] TELEGRAM_TOKEN not found in $ENV_FILE" >&2
  exit 1
fi
STATE_DIR="/tmp/mcp-communicator-telegram-${INSTANCE_HASH}"
PID_FILE="$STATE_DIR/server.pid"
PORT_FILE="$STATE_DIR/server.port"
LOG_FILE="$STATE_DIR/server.log"
LOCK_FILE="$STATE_DIR/spawn.lock"
# Per-wrapper-process (i.e. per Claude Code session) stdout serialization
# lock, so concurrently-dispatched requests (see handle_request) can't
# interleave partial JSON lines on this wrapper's shared stdout. Keyed by our
# own PID: unique per wrapper instance, no cross-session/cross-user sharing
# needed since each session only writes to its own stdout.
STDOUT_LOCK_FILE="$STATE_DIR/stdout-$$.lock"
cleanup_stdout_lock() { rm -f "$STDOUT_LOCK_FILE"; }
trap cleanup_stdout_lock EXIT

# State dir keyed only by sha256(TELEGRAM_TOKEN) so any user with the same
# token shares one daemon (Telegram's getUpdates is mutually exclusive at the
# bot-token level — per-user dirs would cause two daemons to compete for the
# same poll). Group=sudo + setgid (2770) so all sudo members can spawn /
# inspect / clean the shared dir; files inherit gid=sudo via setgid and get
# 0o660 from umask 007. server.log holds Q/A bodies — readable inside sudo
# group, which on this box is the shared-credential trust boundary anyway.
umask 007
mkdir -p "$STATE_DIR"
chgrp sudo "$STATE_DIR" 2>/dev/null || true
chmod 2770 "$STATE_DIR" 2>/dev/null || true

ensure_daemon() {
  # Subshell scopes fd 200 (and therefore the flock) to the critical section.
  # When the subshell exits, the lock releases automatically.
  if ! (
    flock -x 200

    # The daemon holds an exclusive flock on PORT_FILE for life.
    # If we can't acquire it non-blocking, the daemon is alive.
    # This works cross-user because flock is kernel-enforced.
    if ! flock -n "$PORT_FILE" -c "true" 2>/dev/null; then
      exit 0   # daemon alive; nothing to do
    fi
    # Lock is free — no daemon. Clean up stale files (if any).
    rm -f "$PID_FILE" "$PORT_FILE"

    # Close fd 200 for the daemon child so it does not inherit the lock fd
    # from our subshell and keep flock held forever. Close stdin (</dev/null)
    # so the daemon is not pinned to our pipe if CC exits.
    nohup flock -x "$PORT_FILE" node "$DAEMON_BIN" < /dev/null >> "$LOG_FILE" 2>&1 200>&- &
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

# Handle one JSON-RPC request line: forward to the daemon over HTTP and
# print the reply. Runs in its own backgrounded subshell (see main loop)
# so a slow call (e.g. ask_user blocked on a human reply for hours) never
# delays any other request queued behind it on the same stdin — each line
# gets its own curl in flight concurrently.
handle_request() {
  local line="$1"
  ensure_daemon
  local port
  port=$(cat "$PORT_FILE")
  local reply
  reply=$(
    printf '%s' "$line" \
    | curl -sS -X POST "http://127.0.0.1:$port/mcp" \
        -H 'Content-Type: application/json' \
        --data-binary @- \
        --max-time 43200
  ) || {
    echo "[mcp-client] curl failed on request: $line" >&2
    return
  }
  # Empty reply means the request was a JSON-RPC notification — no response.
  if [[ -n "$reply" ]]; then
    # flock scopes the write so two concurrently-finishing requests can't
    # interleave their JSON onto stdout mid-line.
    {
      flock 201
      printf '%s\n' "$reply"
    } 201>"$STDOUT_LOCK_FILE"
  fi
}

# Proxy newline-delimited JSON-RPC on stdin to the daemon over HTTP.
# Re-resolve per request (ensure_daemon checks the flock on server.port,
# which works cross-user) so the session survives the daemon dying and
# being respawned on a new port. Each line is dispatched to a backgrounded
# handle_request so unrelated requests (e.g. notify_user) never wait behind
# a still-pending one (e.g. an unanswered ask_user) on this same connection.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  handle_request "$line" &
done
# Don't let the script (and thus this process) exit while any handle_request
# is still in flight — stdin closing (session end) would otherwise kill
# still-running background jobs before they ever get to print their reply.
wait
