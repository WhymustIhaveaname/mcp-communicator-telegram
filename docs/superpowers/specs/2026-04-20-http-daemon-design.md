# `mcp-communicator-telegram` HTTP Daemon Refactor — Design

**Date**: 2026-04-20
**Status**: Approved — ready for implementation planning
**Target branch**: `http-daemon`

## Problem

The current stdio MCP server is spawned fresh by every Claude Code session that
loads the project's `.mcp.json`. Each spawn opens its own Telegram bot polling
connection via `node-telegram-bot-api` with `polling: true`. Telegram's Bot API
allows only **one concurrent `getUpdates` request per bot token** — the
first-arriving poller locks the bot; subsequent processes get
`409 Conflict: terminated by other getUpdates request` and are permanently
shut out by exponential-backoff retries that always lose to the incumbent.

Observed effect: opening two CC sessions in `/home/youran/Abaqus2024/` produces
deterministic behavior where the first-started session can `ask_user` and
receive replies, and every subsequent session is unable to receive anything.
Stale orphan MCP subprocesses (the server does not exit when its stdio pipe
closes) compound this — one orphan left over from an earlier CC session can
monopolize the bot for hours.

Goal: run a **single** long-lived MCP server process (the "daemon") that owns
the sole polling connection, and let every CC session connect to it as an
HTTP client. Multiple CC windows must be usable concurrently.

## Non-Goals

- Multi-project isolation. The daemon is a machine-wide singleton that serves
  one bot/chat (defined in `mcp-communicator-telegram/.env`). Projects using
  different bots are out of scope.
- HTTP-layer authentication. Loopback-only binding is the sole defense.
- Automatic daemon restart on crash (beyond the wrapper's lazy respawn on next
  demand).
- SSE push / server-initiated notifications. The server only answers
  client-initiated JSON-RPC requests.

## Architecture

```
┌──────────────┐   stdio JSON-RPC   ┌─────────────────────┐
│ CC session A │ ────────────────▶  │  bin/mcp-client.sh  │
│              │ ◀────────────────  │  (bash, ~50 lines)  │
└──────────────┘                    │                     │
                                    │ 1. flock            │
┌──────────────┐   stdio JSON-RPC   │ 2. check server.pid │
│ CC session B │ ────────────────▶  │ 3. spawn if dead    │
│              │ ◀────────────────  │ 4. read server.port │
└──────────────┘                    │ 5. proxy via curl   │
                                    └──────────┬──────────┘
                                               │ HTTP POST
                                               ▼
                                    ┌──────────────────────┐
                                    │ build/index.js       │
                                    │ (daemon, singleton)  │
                                    │ 127.0.0.1:<port>     │
                                    │ Owns the single      │
                                    │ Telegram poll loop   │
                                    └──────────────────────┘
```

Each CC session still spawns its own stdio wrapper (that is how stdio MCP
servers work). But every wrapper is a thin bash proxy that forwards JSON-RPC
messages over HTTP to the one shared daemon. The daemon owns the Telegram bot
state.

Lazy daemon startup: the wrapper only ensures the daemon is alive. No systemd
unit, no always-on process — the first CC session to call a Telegram tool
incurs a ~few-hundred-millisecond startup; subsequent sessions find the
daemon already alive.

## State Layout

Following the `claude-memory-manager` convention — flat single-value files in
a home dot-dir named after the service:

```
~/.mcp-communicator-telegram/
├── server.pid        # daemon PID (one integer)
├── server.port       # daemon listening port (one integer)
├── server.log        # daemon stdout + stderr
└── spawn.lock        # flock target for wrapper concurrency control
```

The daemon writes `server.pid` and `server.port` atomically immediately after
a successful `listen()`. It removes both on graceful shutdown. `spawn.lock` is
created lazily by the first wrapper that needs it and is never deleted.

## Port Selection

- Start from `process.env.MCP_HTTP_PORT ?? 13579`.
- Bind attempts: up to 10 (i.e. 13579 through 13588).
- On `EADDRINUSE`, increment and retry. Any other bind error fails fast.
- Exhausting the range fails with a clear error.
- Bind host is always `127.0.0.1`.

Rationale for 13579: outside the default Linux ephemeral range (32768–60999,
so the OS will not pre-empt the port with an outbound connection), not a
common service port, easy to remember (odd-digit ladder).

## Singleton Enforcement

The wrapper wraps the "check pid → spawn if dead" critical section in an
exclusive `flock`:

```bash
(
  flock -x 200
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    :  # daemon is alive, proceed
  else
    rm -f "$PID_FILE" "$PORT_FILE"
    nohup node "$DAEMON_BIN" >> "$LOG_FILE" 2>&1 &
    for i in $(seq 50); do
      sleep 0.1
      [[ -f "$PORT_FILE" ]] && break
    done
  fi
) 200>"$LOCK_FILE"
```

Two wrappers starting simultaneously: only one enters the critical section
and may spawn; the other blocks on the lock and then sees the freshly-written
`PORT_FILE` when it gets the lock, proceeding to connect without spawning.

## Lifecycle

### Daemon startup

1. `dotenv.config()` reads `<pkg-root>/.env` (via explicit path resolution
   relative to `__dirname`, so cwd does not matter).
2. `initializeBot()` — polling starts, `bot.getMe()` validates the token. On
   failure, `process.exit(1)` **before** any state file is written, so the
   next wrapper invocation retries.
3. `scanAndBind()` — iterate candidate ports; bind `127.0.0.1:<port>`.
4. Write `server.pid` and `server.port` synchronously.
5. Enter HTTP event loop.

### Daemon shutdown

Three exit paths, all must leave the state dir consistent:

- `SIGINT` / `SIGTERM`: `bot.stopPolling()`, unlink `server.pid` and
  `server.port`, `process.exit(0)`.
- Uncaught exception: `process.on('exit')` hook unlinks the state files
  synchronously as a safety net.
- `kill -9`: state files persist with a stale PID. The wrapper's
  `kill -0 <pid>` probe detects the pid is gone and cleans up on next
  invocation. State self-heals; no manual intervention needed.

### Wrapper lifecycle

CC closes the session → CC closes the wrapper's stdin → `while IFS= read`
returns EOF → wrapper exits. **The wrapper never kills the daemon.** The
daemon is a shared resource; its lifetime is decoupled from any individual
CC window. The daemon dies only via (1) manual `kill`, (2) machine reboot,
(3) its own crash.

## Behavior Change: Plain-Message Fallback Removed

Current code has a fallback that routes any plain Telegram message to the
most recent `ask_user` question if the user did not use the "Reply" feature:

```typescript
if (!questionId) { questionId = lastQuestionId; }
```

This is removed as part of this refactor. The new rule: **only messages sent
via Telegram's "Reply" feature whose `reply_to_message.text` contains a
recognizable `#<questionId>` tag are routed to `pendingQuestions`**. Plain
messages are logged and discarded. The `lastQuestionId` module-level
variable is deleted along with the fallback.

Motivation: with multiple concurrent CC sessions each potentially holding
open `ask_user` promises on the same daemon, "most recent question" becomes
ambiguous. The explicit-reply-only rule is unambiguous and scales.

## Error Handling

### Daemon

| Condition | Behavior |
|---|---|
| `.env` missing `TELEGRAM_TOKEN` or `CHAT_ID` | Throw on startup; process exits before state files written. |
| Telegram `getMe` fails | `initializeBot` returns false → `process.exit(1)` before state files written. |
| All 10 candidate ports occupied | Throw `Error: no free port in 13579-13588`. |
| Non-JSON POST body | HTTP 400, JSON-RPC `-32700 Parse error`. |
| Tool handler throws | JSON-RPC `-32000` with the thrown message. |
| HTTP client disconnects mid-`ask_user` | Daemon's pending promise remains until a Telegram reply arrives; response write fails silently; `pendingQuestions` entry is removed on reply. |

### Wrapper

| Condition | Behavior |
|---|---|
| Another wrapper holds `spawn.lock` | `flock` blocks until released — automatic queueing. |
| 5 seconds elapse without `server.port` appearing | Emit `[mcp-client] daemon failed to start, see ~/.mcp-communicator-telegram/server.log` to stderr; exit 1. CC surfaces this as MCP connection failure. |
| Daemon dies mid-request (curl returns ECONNREFUSED) | Current request returns HTTP error to CC via JSON-RPC; next request retriggers pid/port probe and lazy respawn. **No automatic retry of the failed request** — CC sees the error via MCP's normal error channel. |
| CC closes stdin | `while read` hits EOF, wrapper exits cleanly. |

## Repository Changes

`mcp-communicator-telegram` (branch `http-daemon`):

- `src/index.ts` — transport swap (stdio → HTTP), port-scan loop, state-file
  management, removal of `lastQuestionId` fallback.
- `bin/mcp-client.sh` — new bash wrapper (~50 lines, executable, shebang).
- `package.json` — bump version `0.2.1` → `0.3.0`.
- `README.md` — document the new architecture, state dir, port range, and
  troubleshooting steps (how to inspect `server.log`, how to force a
  respawn).

No new npm dependencies. `http` is built-in; `flock` and `curl` are Linux
standard.

`Abaqus2024/.mcp.json`:

```json
{
  "mcpServers": {
    "mcp-communicator-telegram": {
      "type": "stdio",
      "command": "/home/youran/Abaqus2024/mcp-communicator-telegram/bin/mcp-client.sh"
    }
  }
}
```

## Verification

Executed in order after implementation:

1. **Wrapper-daemon handshake.** `./bin/mcp-client.sh <<< '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'`. Expect daemon to
   spawn, correct JSON on stdout, `server.{pid,port}` present with valid
   contents.
2. **Port conflict fallback.** `nc -l 13579` in one terminal, then run the
   wrapper. Expect daemon to land on 13580 and write 13580 to `server.port`.
3. **Self-healing respawn.** `kill -9 $(cat ~/.mcp-communicator-telegram/server.pid)`, then rerun the wrapper. Expect detection of dead pid,
   cleanup, respawn with new pid.
4. **Spawn race.** Two shells invoke the wrapper nearly simultaneously.
   Expect exactly one daemon process (`pgrep -cf "node.*build/index.js" == 1`).
5. **Multi-session sharing (final acceptance).** Close all CC sessions,
   `rm -rf ~/.mcp-communicator-telegram`. Open two CC sessions, both
   starting `/supervisor`. Each calls `ask_user`. Both must receive the
   Telegram user's replies — **user must use Telegram's "Reply" feature**
   when answering each question, since the plain-message fallback is
   removed.
6. **Plain-message regression.** Send a non-Reply plain message in Telegram.
   `server.log` should record "No matching question found" and no pending
   question should be resolved.
