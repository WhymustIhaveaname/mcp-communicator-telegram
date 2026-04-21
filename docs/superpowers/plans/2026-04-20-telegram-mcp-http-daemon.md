# Telegram MCP HTTP Daemon Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-CC-session stdio MCP server with a shared HTTP daemon so multiple Claude Code windows can concurrently use the same Telegram bot without racing `getUpdates`.

**Architecture:** Single long-lived daemon process (`build/index.js`) listens on a loopback HTTP port, owns the only Telegram polling connection, and writes PID/port to `/tmp/mcp-communicator-telegram-$USER/`. Each CC session spawns a thin bash wrapper (`bin/mcp-client.sh`) that ensures the daemon is alive, reads the port, and proxies stdio JSON-RPC traffic to the daemon over HTTP. `.mcp.json` points at the wrapper instead of `node build/index.js`.

**Tech Stack:** Node.js/TypeScript (`node-telegram-bot-api`, built-in `http`, `dotenv`), bash (`flock`, `curl`). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-04-20-http-daemon-design.md`

**Starting state:** Branch `http-daemon` of `mcp-communicator-telegram`. `src/index.ts` has an **uncommitted WIP** that already converts the stdio transport to HTTP but does **not yet** do port scanning, state-file writing, state cleanup, or removal of the `lastQuestionId` fallback. Task 1 commits this WIP as a checkpoint; subsequent tasks add increments.

---

### Task 1: Commit the existing HTTP-skeleton WIP as a checkpoint

**Files:**
- Already modified (uncommitted): `src/index.ts`

This captures the in-progress transport swap so every later task starts from a clean `git status`.

- [ ] **Step 1: Verify WIP compiles**

Run:
```bash
cd /home/youran/Abaqus2024/mcp-communicator-telegram
npm run build
```

Expected: no output besides the tsc invocation line; exit 0.

- [ ] **Step 2: Confirm the WIP state**

Run:
```bash
git status
git diff --stat
```

Expected: on branch `http-daemon`, one modified file `src/index.ts`, ~245 insertions / 303 deletions.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "Convert stdio MCP transport to HTTP skeleton

Swap the hand-rolled stdio JSON-RPC handler for a Node http server on
a fixed loopback port. No port scanning or state-file management yet;
those arrive in follow-up commits. dotenv now reads .env via an
explicit path so cwd no longer matters."
```

Expected: commit succeeds, `git status` clean.

---

### Task 2: Add port scanning and make the default port 13579

**Files:**
- Modify: `src/index.ts` (top-of-file constants + `startHttpServer`)

**Current problem:** the daemon binds a fixed port. If it's occupied the daemon crashes with `EADDRINUSE`. The spec calls for scanning 13579–13588.

- [ ] **Step 1: Write a failing check**

This check will become part of the self-verification. Save as `/tmp/test-port-scan.sh`:

```bash
#!/usr/bin/env bash
set -e
# Occupy the default port 13579
nc -l 127.0.0.1 13579 >/dev/null &
NC_PID=$!
trap "kill $NC_PID 2>/dev/null; rm -rf /tmp/mcp-communicator-telegram-$USER; pkill -f 'node.*build/index.js' 2>/dev/null; exit" EXIT

sleep 0.3

# Start daemon; should pick 13580 because 13579 is taken
cd /home/youran/Abaqus2024/mcp-communicator-telegram
rm -rf /tmp/mcp-communicator-telegram-$USER
nohup node build/index.js > /tmp/daemon-test.log 2>&1 &
sleep 2

# Expected chosen port, printed in daemon log
grep -q "listening on http://127.0.0.1:13580" /tmp/daemon-test.log \
  && echo "PASS: daemon skipped 13579 and bound 13580" \
  || { echo "FAIL: daemon did not skip the occupied port"; cat /tmp/daemon-test.log; exit 1; }
```

Make executable and run:
```bash
chmod +x /tmp/test-port-scan.sh
/tmp/test-port-scan.sh
```

Expected: **FAIL** because the current code binds the fixed `HTTP_PORT` and errors out with `EADDRINUSE`.

- [ ] **Step 2: Modify `src/index.ts`**

Find this block near the top (around line 18):
```typescript
const HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT ?? '8765', 10);
const HTTP_HOST = process.env.MCP_HTTP_HOST ?? '127.0.0.1';
```

Replace with:
```typescript
const HTTP_PORT_START = parseInt(process.env.MCP_HTTP_PORT ?? '13579', 10);
const HTTP_PORT_TRIES = 10;
const HTTP_HOST = process.env.MCP_HTTP_HOST ?? '127.0.0.1';
```

Find the existing `startHttpServer` function (around line 403–459) and replace it **in its entirety** with the version below. The request-handling internals are unchanged; what changes is the return type (`Promise<{ server, port }>` instead of `http.Server`) and the port-scan loop that wraps `listen`:

```typescript
async function startHttpServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found\n');
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let request: any;
      try {
        request = JSON.parse(body);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: 'Parse error' }
        }));
        return;
      }

      try {
        const response = await dispatchRequest(request);
        if (response === null) {
          res.writeHead(202);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        }
      } catch (error: any) {
        console.error('Error handling request:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: request?.id ?? null,
          error: { code: -32000, message: error.message }
        }));
      }
    });
  });

  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;

  for (let offset = 0; offset < HTTP_PORT_TRIES; offset++) {
    const candidate = HTTP_PORT_START + offset;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener('listening', onListen);
          reject(err);
        };
        const onListen = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(candidate, HTTP_HOST);
      });
      console.error(`MCP HTTP server listening on http://${HTTP_HOST}:${candidate}/mcp`);
      return { server, port: candidate };
    } catch (err: any) {
      if (err.code !== 'EADDRINUSE') throw err;
      console.error(`Port ${candidate} in use, trying next`);
    }
  }

  throw new Error(`No free port in range ${HTTP_PORT_START}-${HTTP_PORT_START + HTTP_PORT_TRIES - 1}`);
}
```

Update `main()` (around line 470) to `await` the new async signature:
```typescript
async function main() {
  const success = await initializeBot();
  if (!success) {
    console.error('Failed to initialize bot, exiting...');
    process.exit(1);
  }
  await startHttpServer();
}
```

- [ ] **Step 3: Rebuild and run the check**

```bash
npm run build
/tmp/test-port-scan.sh
```

Expected: **PASS** (daemon skips 13579, binds 13580).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "Scan ports 13579-13588 when binding the HTTP server

EADDRINUSE on the current candidate advances to the next; any other
listen error is fatal. Default start port 13579 is outside the Linux
ephemeral range and not a common service port. MCP_HTTP_PORT still
overrides the start if set."
```

---

### Task 3: Write state files after successful bind

**Files:**
- Modify: `src/index.ts` (imports, `main`, new helper)

After the HTTP server binds, the daemon must advertise itself by writing `/tmp/mcp-communicator-telegram-$USER/server.pid` and `server.port` so the wrapper can find it.

- [ ] **Step 1: Write a failing check**

Save `/tmp/test-state-write.sh`:

```bash
#!/usr/bin/env bash
set -e
trap "rm -rf /tmp/mcp-communicator-telegram-$USER; pkill -f 'node.*build/index.js' 2>/dev/null; exit" EXIT

cd /home/youran/Abaqus2024/mcp-communicator-telegram
rm -rf /tmp/mcp-communicator-telegram-$USER
nohup node build/index.js > /tmp/daemon-test.log 2>&1 &
BG=$!
sleep 2

pid_file=/tmp/mcp-communicator-telegram-$USER/server.pid
port_file=/tmp/mcp-communicator-telegram-$USER/server.port

[[ -f "$pid_file" ]] || { echo "FAIL: no server.pid"; exit 1; }
[[ -f "$port_file" ]] || { echo "FAIL: no server.port"; exit 1; }

recorded_pid=$(cat "$pid_file")
recorded_port=$(cat "$port_file")

[[ "$recorded_pid" == "$BG" ]] || { echo "FAIL: pid mismatch ($recorded_pid vs $BG)"; exit 1; }
[[ "$recorded_port" == "13579" ]] || { echo "FAIL: port unexpected ($recorded_port)"; exit 1; }

echo "PASS: state files written with pid=$recorded_pid port=$recorded_port"
```

```bash
chmod +x /tmp/test-state-write.sh
/tmp/test-state-write.sh
```

Expected: **FAIL** ("no server.pid"), because no state writing exists yet.

- [ ] **Step 2: Modify `src/index.ts`**

Add a constant block near the other constants (after `HTTP_HOST`):
```typescript
import * as os from 'os';
const STATE_DIR = path.join('/tmp', `mcp-communicator-telegram-${os.userInfo().username}`);
const PID_FILE = path.join(STATE_DIR, 'server.pid');
const PORT_FILE = path.join(STATE_DIR, 'server.port');
```

(`os` needs a top-level `import`; place it next to the other imports.)

Update `main()` to write the state files after bind:
```typescript
async function main() {
  const success = await initializeBot();
  if (!success) {
    console.error('Failed to initialize bot, exiting...');
    process.exit(1);
  }
  const { port } = await startHttpServer();

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
  fs.writeFileSync(PORT_FILE, `${port}\n`);
  console.error(`State recorded: pid=${process.pid} port=${port} in ${STATE_DIR}`);
}
```

- [ ] **Step 3: Rebuild and run the check**

```bash
npm run build
/tmp/test-state-write.sh
```

Expected: **PASS**.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "Write server.pid and server.port after successful bind

State dir is /tmp/mcp-communicator-telegram-$USER, following the
claude-memory-manager flat-single-value-file convention. These files
let the wrapper script locate and health-check the daemon."
```

---

### Task 4: Clean up state files on shutdown

**Files:**
- Modify: `src/index.ts` (shutdown handler + `process.on('exit')`)

Currently, `SIGINT`/`SIGTERM` call `bot.stopPolling()` and `process.exit(0)` but leave stale state files behind. The wrapper's `kill -0 <pid>` probe will detect this and self-heal, but graceful shutdowns should leave no litter.

- [ ] **Step 1: Write a failing check**

Save `/tmp/test-state-cleanup.sh`:
```bash
#!/usr/bin/env bash
set -e
trap "rm -rf /tmp/mcp-communicator-telegram-$USER; pkill -f 'node.*build/index.js' 2>/dev/null; exit" EXIT

cd /home/youran/Abaqus2024/mcp-communicator-telegram
rm -rf /tmp/mcp-communicator-telegram-$USER
nohup node build/index.js > /tmp/daemon-test.log 2>&1 &
BG=$!
sleep 2

[[ -f /tmp/mcp-communicator-telegram-$USER/server.pid ]] || { echo "setup fail: no pid file"; exit 1; }

kill -TERM "$BG"
sleep 1

[[ -f /tmp/mcp-communicator-telegram-$USER/server.pid ]] \
  && { echo "FAIL: server.pid survived SIGTERM"; exit 1; } \
  || echo "server.pid cleaned"

[[ -f /tmp/mcp-communicator-telegram-$USER/server.port ]] \
  && { echo "FAIL: server.port survived SIGTERM"; exit 1; } \
  || echo "server.port cleaned"

echo "PASS: graceful shutdown cleans up state files"
```

```bash
chmod +x /tmp/test-state-cleanup.sh
/tmp/test-state-cleanup.sh
```

Expected: **FAIL** ("server.pid survived SIGTERM").

- [ ] **Step 2: Modify `src/index.ts`**

Replace the existing `shutdown` block (around line 461):

```typescript
const cleanupState = () => {
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(PORT_FILE); } catch {}
};

const shutdown = () => {
  if (bot) {
    bot.stopPolling();
  }
  cleanupState();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', cleanupState);
```

The `process.on('exit')` handler is a synchronous safety net for uncaught exceptions so crashes don't leave stale state either. `fs.unlinkSync` is safe inside an `exit` handler.

- [ ] **Step 3: Rebuild and run the check**

```bash
npm run build
/tmp/test-state-cleanup.sh
```

Expected: **PASS**.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "Delete pid/port state files on graceful shutdown

SIGINT/SIGTERM now clean up explicitly; process.on('exit') runs the
same cleanup synchronously as a safety net for uncaught exceptions.
Kill -9 still leaves stale files — the wrapper heals by probing the
stale pid with kill -0."
```

---

### Task 5: Remove the `lastQuestionId` plain-message fallback

**Files:**
- Modify: `src/index.ts` (imports around line 22 + message handler around line 59)

Per the spec, plain Telegram messages (not sent via Reply) should no longer be routed to the most recent `ask_user`. They should be logged and discarded.

- [ ] **Step 1: Write the failing check**

Save `/tmp/test-plain-message.sh`. (This test uses direct Telegram API calls to simulate a plain message; it requires `TELEGRAM_TOKEN` and `CHAT_ID` loaded from the .env.)

```bash
#!/usr/bin/env bash
set -e
cd /home/youran/Abaqus2024/mcp-communicator-telegram
source .env

trap "rm -rf /tmp/mcp-communicator-telegram-$USER; pkill -f 'node.*build/index.js' 2>/dev/null; exit" EXIT

rm -rf /tmp/mcp-communicator-telegram-$USER
nohup node build/index.js > /tmp/daemon-test.log 2>&1 &
sleep 2

PORT=$(cat /tmp/mcp-communicator-telegram-$USER/server.port)

# Fire ask_user in background (will block waiting for a reply)
(curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_user","arguments":{"question":"test-plain-message"}}}' \
  > /tmp/askuser-response.json) &

sleep 3  # give Telegram a moment

# Simulate a plain (non-Reply) message from the user
curl -sS "https://api.telegram.org/bot$TELEGRAM_TOKEN/sendMessage" \
  -d "chat_id=$CHAT_ID" \
  -d "text=this is a plain message, should NOT resolve ask_user" > /dev/null

sleep 3

# If the old fallback still exists, ask_user resolved and askuser-response.json has content
if [[ -s /tmp/askuser-response.json ]] && grep -q '"result"' /tmp/askuser-response.json; then
  echo "FAIL: ask_user was resolved by a plain message"
  cat /tmp/askuser-response.json
  exit 1
fi

# Daemon log should record the rejection
grep -q "No matching question found" /tmp/daemon-test.log \
  && echo "PASS: plain message was ignored" \
  || { echo "FAIL: daemon did not log the ignore"; tail -20 /tmp/daemon-test.log; exit 1; }
```

```bash
chmod +x /tmp/test-plain-message.sh
/tmp/test-plain-message.sh
```

Expected: **FAIL** ("ask_user was resolved by a plain message"), because the `lastQuestionId` fallback still routes plain messages.

- [ ] **Step 2: Modify `src/index.ts`**

Find the module-level declaration (around line 22):
```typescript
let lastQuestionId: string | null = null;
```
**Delete this line.**

Find the `askUser` function's line that sets it (around where `lastQuestionId = questionId;` appears, after `const questionId = ...`):
```typescript
  lastQuestionId = questionId;
```
**Delete this line.**

Find the message handler (around lines 59–61):
```typescript
      if (!questionId) {
        questionId = lastQuestionId;
      }
```
**Delete these three lines.**

Also find the cleanup line inside the "Found matching question" branch (around line 70–71):
```typescript
        lastQuestionId = null;
```
**Delete this line.**

Update the log line (around line 63) from:
```typescript
      console.error('Question ID (from reply or last):', questionId);
```
to:
```typescript
      console.error('Question ID (from Reply only):', questionId);
```

- [ ] **Step 3: Rebuild and run the check**

```bash
npm run build
/tmp/test-plain-message.sh
```

Expected: **PASS** ("plain message was ignored").

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "Ignore plain Telegram messages; only explicit Replies are routed

Remove the lastQuestionId fallback. With multiple concurrent CC
sessions holding open ask_user promises on the same daemon, 'most
recent question' is ambiguous and unsafe. The reply-to-message route
with #<questionId> tag is the only resolution path now."
```

---

### Task 6: Create `bin/mcp-client.sh` wrapper

**Files:**
- Create: `bin/mcp-client.sh`

The wrapper is the only file CC's `.mcp.json` launches. It handles liveness detection, daemon spawn with flock, and stdio↔HTTP proxying.

- [ ] **Step 1: Write a failing check**

Save `/tmp/test-wrapper-basic.sh`:
```bash
#!/usr/bin/env bash
set -e
trap "rm -rf /tmp/mcp-communicator-telegram-$USER; pkill -f 'node.*build/index.js' 2>/dev/null; exit" EXIT

rm -rf /tmp/mcp-communicator-telegram-$USER
pkill -f 'node.*build/index.js' 2>/dev/null || true

WRAPPER=/home/youran/Abaqus2024/mcp-communicator-telegram/bin/mcp-client.sh
[[ -x "$WRAPPER" ]] || { echo "FAIL: wrapper not present or not executable"; exit 1; }

# Send a single initialize request, check for a well-formed JSON-RPC response
reply=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' | timeout 10 "$WRAPPER")

echo "$reply" | grep -q '"protocolVersion":"2024-11-05"' \
  && echo "PASS: wrapper handshakes via stdio/HTTP proxy" \
  || { echo "FAIL: unexpected reply"; echo "$reply"; exit 1; }
```

```bash
chmod +x /tmp/test-wrapper-basic.sh
/tmp/test-wrapper-basic.sh
```

Expected: **FAIL** ("wrapper not present or not executable").

- [ ] **Step 2: Create `bin/mcp-client.sh`**

Save exactly as written:

```bash
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

    nohup node "$DAEMON_BIN" >> "$LOG_FILE" 2>&1 &
    disown

    # Wait up to 5s for the daemon to write its port file.
    for _ in $(seq 50); do
      if [[ -f "$PORT_FILE" ]]; then
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
```

Then make it executable:
```bash
chmod +x bin/mcp-client.sh
```

- [ ] **Step 3: Run the check**

```bash
/tmp/test-wrapper-basic.sh
```

Expected: **PASS** ("wrapper handshakes via stdio/HTTP proxy").

- [ ] **Step 4: Commit**

```bash
git add bin/mcp-client.sh
git commit -m "Add bin/mcp-client.sh: stdio-HTTP bridge with lazy daemon spawn

Each CC session spawns one wrapper. The wrapper acquires an exclusive
flock on spawn.lock, probes the daemon via kill -0 on server.pid,
respawns if dead, then proxies newline-delimited JSON-RPC from stdin
over HTTP to the daemon."
```

---

### Task 7: Verify wrapper self-heals after daemon death

**Files:** no code changes — this is a verification task confirming the behavior built in Tasks 2–6.

- [ ] **Step 1: Run the self-heal check**

Save `/tmp/test-wrapper-selfheal.sh`:
```bash
#!/usr/bin/env bash
set -e
trap "rm -rf /tmp/mcp-communicator-telegram-$USER; pkill -f 'node.*build/index.js' 2>/dev/null; exit" EXIT

WRAPPER=/home/youran/Abaqus2024/mcp-communicator-telegram/bin/mcp-client.sh

rm -rf /tmp/mcp-communicator-telegram-$USER
pkill -f 'node.*build/index.js' 2>/dev/null || true

# First run spawns a fresh daemon
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  | timeout 10 "$WRAPPER" > /dev/null
first_pid=$(cat /tmp/mcp-communicator-telegram-$USER/server.pid)
echo "First daemon pid: $first_pid"

# Nuke it
kill -9 "$first_pid"
sleep 0.5

# Second run should detect the dead pid, clean state, and respawn
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  | timeout 10 "$WRAPPER" > /dev/null
second_pid=$(cat /tmp/mcp-communicator-telegram-$USER/server.pid)
echo "Second daemon pid: $second_pid"

[[ "$first_pid" != "$second_pid" ]] \
  && kill -0 "$second_pid" 2>/dev/null \
  && echo "PASS: wrapper respawned a fresh daemon" \
  || { echo "FAIL: no fresh daemon"; exit 1; }
```

```bash
chmod +x /tmp/test-wrapper-selfheal.sh
/tmp/test-wrapper-selfheal.sh
```

Expected: **PASS** ("wrapper respawned a fresh daemon").

- [ ] **Step 2: Run the spawn-race check**

Save `/tmp/test-wrapper-race.sh`:
```bash
#!/usr/bin/env bash
set -e
trap "rm -rf /tmp/mcp-communicator-telegram-$USER; pkill -f 'node.*build/index.js' 2>/dev/null; exit" EXIT

WRAPPER=/home/youran/Abaqus2024/mcp-communicator-telegram/bin/mcp-client.sh

rm -rf /tmp/mcp-communicator-telegram-$USER
pkill -f 'node.*build/index.js' 2>/dev/null || true

# Fire two wrappers at essentially the same time
for i in 1 2; do
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
    | timeout 10 "$WRAPPER" > /dev/null &
done
wait

count=$(pgrep -cf 'node.*build/index.js' || true)
[[ "$count" -eq 1 ]] \
  && echo "PASS: exactly one daemon after concurrent spawn" \
  || { echo "FAIL: $count daemons after concurrent spawn"; pgrep -af 'node.*build/index.js'; exit 1; }
```

```bash
chmod +x /tmp/test-wrapper-race.sh
/tmp/test-wrapper-race.sh
```

Expected: **PASS** ("exactly one daemon after concurrent spawn").

- [ ] **Step 3: No commit needed** — verification only. If either check failed, revisit Task 6.

---

### Task 8: Point `.mcp.json` at the wrapper

**Files:**
- Modify: `/home/youran/Abaqus2024/.mcp.json`

This is the final production cutover. The existing `.mcp.json` from the earlier partial refactor still points at HTTP-mode directly; revert it to stdio-with-wrapper.

- [ ] **Step 1: Stop any running daemon and clear state**

```bash
pkill -f 'node.*build/index.js' 2>/dev/null || true
rm -rf /tmp/mcp-communicator-telegram-$USER
```

- [ ] **Step 2: Overwrite `/home/youran/Abaqus2024/.mcp.json`**

Replace the file contents with exactly:

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

- [ ] **Step 3: Verify via a fresh wrapper invocation**

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  | /home/youran/Abaqus2024/mcp-communicator-telegram/bin/mcp-client.sh
```

Expected output: single JSON line containing `"protocolVersion":"2024-11-05"` and `"serverInfo":{"name":"mcp-communicator-telegram"`. The daemon starts automatically; `pgrep -f 'node.*build/index.js'` shows one process.

- [ ] **Step 4: (Abaqus2024 is not a git repo — no commit here.) Note that the wrapper repo still has no change in this step.**

---

### Task 9: Bump version and update `README.md`

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Bump `package.json` version**

Change:
```json
  "version": "0.2.1",
```
to:
```json
  "version": "0.3.0",
```

- [ ] **Step 2: Update `README.md`**

Read `README.md` first to see the current structure, then rewrite the installation / configuration / troubleshooting sections. Keep these points:

- This server now runs as a singleton HTTP daemon, lazily spawned by `bin/mcp-client.sh`.
- State lives in `/tmp/mcp-communicator-telegram-$USER/`: `server.pid`, `server.port`, `server.log`.
- Default port is 13579, scanning up to 13588 on conflict. Override with `MCP_HTTP_PORT`.
- `.mcp.json` entry is stdio pointing at `bin/mcp-client.sh` (example given).
- To reset: `pkill -f 'node.*build/index.js' ; rm -rf /tmp/mcp-communicator-telegram-$USER`.
- Only Telegram messages sent via **Reply** resolve pending `ask_user` questions; plain messages are ignored.

Keep existing sections about `get-chat-id.js`, `.env` setup, and tool descriptions.

- [ ] **Step 3: Build to confirm package.json is still valid**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "Bump to 0.3.0 and document the HTTP daemon architecture

0.3.0 is the first release with the shared HTTP daemon, stdio wrapper,
state dir /tmp/mcp-communicator-telegram-$USER, and reply-only question
routing. README covers the new topology, default port range, and
troubleshooting/reset procedure."
```

---

### Task 10: End-to-end acceptance — multi-CC concurrent `ask_user`

**Files:** no code changes — this is the manual acceptance test from the spec.

Requires a human in the loop for the Telegram side. Cannot be fully automated.

- [ ] **Step 1: Clean slate**

```bash
pkill -f 'node.*build/index.js' 2>/dev/null || true
rm -rf /tmp/mcp-communicator-telegram-$USER
rm -f /tmp/daemon-test.log
```

- [ ] **Step 2: Open two CC sessions**

Open two terminals. In each, run:
```bash
cd /home/youran/Abaqus2024
claude --plugin-dir ../geo-lab
```
In each, start the supervisor flow: `/supervisor`.

- [ ] **Step 3: In each session, invoke `ask_user`**

Ask each supervisor session to send a different `ask_user` question via Telegram. Observe: both questions arrive in Telegram.

- [ ] **Step 4: Reply to each question using Telegram's Reply feature**

For each question message, tap **Reply** in Telegram and send a distinct answer.

- [ ] **Step 5: Confirm both CC sessions received their matching reply**

Each CC session's `ask_user` tool call should return the answer sent in response to ITS question, not the other's.

- [ ] **Step 6: Negative check — plain message is ignored**

While a fresh `ask_user` is pending, send a plain (non-Reply) message in the chat. The pending `ask_user` should **not** resolve. Daemon log (`/tmp/mcp-communicator-telegram-$USER/server.log`) should contain "No matching question found".

- [ ] **Step 7: Wrap up**

If all checks pass:
```bash
cd /home/youran/Abaqus2024/mcp-communicator-telegram
git log --oneline -n 10   # review the 8 new commits on http-daemon
```

Final state: branch `http-daemon` contains (in order): WIP checkpoint, port scan, state write, state cleanup, reply-only routing, wrapper script, version bump + README. `Abaqus2024/.mcp.json` points at the wrapper. Two CC sessions can share one Telegram bot without racing.

Merging `http-daemon` → `main` in the MCP repo is the user's call, not part of this plan.

---

## Verification Summary

| Spec check | Covered by | Automated? |
|---|---|---|
| §Verification 1 — handshake | Task 6 step 3 | ✅ `/tmp/test-wrapper-basic.sh` |
| §Verification 2 — port conflict | Task 2 step 3 | ✅ `/tmp/test-port-scan.sh` |
| §Verification 3 — self-heal | Task 7 step 1 | ✅ `/tmp/test-wrapper-selfheal.sh` |
| §Verification 4 — spawn race | Task 7 step 2 | ✅ `/tmp/test-wrapper-race.sh` |
| §Verification 5 — multi-CC acceptance | Task 10 | ⚠️ Manual (human Telegram reply needed) |
| §Verification 6 — plain-message regression | Task 5 step 3, Task 10 step 6 | ✅ `/tmp/test-plain-message.sh` + manual |

Six of the spec's verification items become automated bash scripts; the final end-to-end acceptance needs a human because Telegram interaction is involved.
