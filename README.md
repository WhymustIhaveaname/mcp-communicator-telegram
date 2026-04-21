# MCP Communicator (Telegram)

An MCP server that enables communication with users through Telegram. This server provides tools to interact with users via a Telegram bot, including asking questions, sending notifications, sharing files, and creating project archives.

## Architecture

Starting with v0.3.0, this project runs as a **singleton HTTP daemon** rather than a per-session stdio process.

How it works:

- `bin/mcp-client.sh` is the stdio entry point that each Claude Code session connects to.
- On first use, the wrapper lazily spawns a background Node.js HTTP daemon (`build/index.js`).
- Subsequent Claude Code sessions detect the running daemon and reuse it instead of starting a new one.
- All MCP tool calls are forwarded from the wrapper to the daemon over HTTP on localhost.

This design eliminates the race condition that occurred when multiple Claude Code sessions competed for the Telegram bot polling lock.

## State Directory

The daemon stores its runtime state in `/tmp/mcp-communicator-telegram-$USER/`:

| File | Purpose |
|------|---------|
| `server.pid` | PID of the running daemon |
| `server.port` | Port the daemon is listening on |
| `server.log` | Daemon stdout/stderr log |
| `spawn.lock` | Lock file used during daemon startup |

## Port Selection

The daemon binds to the first available port in the range **13579–13588** (inclusive). If all ports in the range are occupied, startup fails with an error.

To force a specific starting port, set the `MCP_HTTP_PORT` environment variable:

```bash
MCP_HTTP_PORT=13600 bin/mcp-client.sh
```

## Prerequisites

- Node.js (v14 or higher)
- A Telegram bot token (obtained from [@BotFather](https://t.me/botfather))
- Your Telegram chat ID (see below)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/qpd-v/mcp-communicator-telegram.git
cd mcp-communicator-telegram
```

2. Install dependencies and build:
```bash
npm install
npm run build
```

3. Create a Telegram bot:
   - Open Telegram and search for [@BotFather](https://t.me/botfather)
   - Send `/newbot` and follow the instructions
   - Save the bot token you receive

4. Get your chat ID:
   - Copy `.env.example` to `.env`
   - Add your bot token to the `.env` file:
     ```
     TELEGRAM_TOKEN=your_bot_token_here
     ```
   - Run the chat ID utility:
     ```bash
     node build/get-chat-id.js
     ```
   - Send any message to your bot in Telegram
   - Copy the chat ID that appears in the console
   - Add the chat ID to your `.env` file:
     ```
     TELEGRAM_TOKEN=your_bot_token_here
     CHAT_ID=your_chat_id_here
     ```

## Configuration

Add the server to your `.mcp.json` (or equivalent MCP settings file), pointing the `command` at the wrapper script:

```json
{
  "mcpServers": {
    "mcp-communicator-telegram": {
      "type": "stdio",
      "command": "/path/to/mcp-communicator-telegram/bin/mcp-client.sh"
    }
  }
}
```

Replace `/path/to/mcp-communicator-telegram` with the absolute path to your checkout.

The wrapper reads `TELEGRAM_TOKEN` and `CHAT_ID` from the `.env` file in the project root, so no additional `env` block is needed in most setups.

## Available Tools

### ask_user

Asks a question to the user via Telegram and waits for their response.

**Important:** Only Telegram messages sent as a **Reply** to the bot's question message will resolve the pending `ask_user` call. Plain (non-reply) messages sent to the bot are logged and ignored. This prevents accidental responses from being mistaken for answers.

Input Schema:
```json
{
  "type": "object",
  "properties": {
    "question": {
      "type": "string",
      "description": "The question to ask the user"
    }
  },
  "required": ["question"]
}
```

Example usage:
```typescript
const response = await use_mcp_tool({
  server_name: "mcp-communicator-telegram",
  tool_name: "ask_user",
  arguments: {
    question: "What is your favorite color?"
  }
});
```

### notify_user

Sends a notification message to the user via Telegram (no response required).

Input Schema:
```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "The message to send to the user"
    }
  },
  "required": ["message"]
}
```

Example usage:
```typescript
await use_mcp_tool({
  server_name: "mcp-communicator-telegram",
  tool_name: "notify_user",
  arguments: {
    message: "Task completed successfully!"
  }
});
```

### send_file

Sends a file to the user via Telegram.

Input Schema:
```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "description": "The path to the file to send"
    }
  },
  "required": ["filePath"]
}
```

Example usage:
```typescript
await use_mcp_tool({
  server_name: "mcp-communicator-telegram",
  tool_name: "send_file",
  arguments: {
    filePath: "path/to/file.txt"
  }
});
```

### zip_project

Creates a zip file of a project directory (respecting .gitignore patterns) and sends it to the user via Telegram.

Input Schema:
```json
{
  "type": "object",
  "properties": {
    "directory": {
      "type": "string",
      "description": "Directory to zip (defaults to current working directory)"
    }
  },
  "required": []
}
```

Example usage with default directory (current working directory):
```typescript
await use_mcp_tool({
  server_name: "mcp-communicator-telegram",
  tool_name: "zip_project",
  arguments: {}
});
```

Example usage with specific directory:
```typescript
await use_mcp_tool({
  server_name: "mcp-communicator-telegram",
  tool_name: "zip_project",
  arguments: {
    directory: "/path/to/your/project"
  }
});
```

Features:
- Creates a zip file named `[project-name]-project.zip` based on the directory name
- Can zip any specified directory or the current working directory
- Respects .gitignore patterns
- Maintains correct file paths in the archive
- Automatically cleans up the zip file after sending
- Handles files up to 2GB in size

## Reset / Troubleshooting

If the daemon gets into a bad state (e.g., port conflict, stale PID file, Telegram polling error), force a clean restart:

```bash
pkill -f 'node.*build/index.js'
rm -rf /tmp/mcp-communicator-telegram-$USER
```

The next MCP tool call from any Claude Code session will spawn a fresh daemon.

Other common issues:

- **Daemon not starting**: Check `/tmp/mcp-communicator-telegram-$USER/server.log` for error output.
- **Bot not responding to replies**: Ensure `CHAT_ID` in `.env` matches the chat where you are replying. The bot only accepts messages from the configured chat ID.
- **Port range exhausted**: All ports 13579–13588 are in use. Either free a port or set `MCP_HTTP_PORT` to an available range start.

## Development

Build the project:
```bash
npm run build
```

Run in development mode:
```bash
npm run dev
```

Watch for changes:
```bash
npm run watch
```

Clean build directory:
```bash
npm run clean
```

## Security

- The server only responds to messages from the configured chat ID
- Environment variables are used for sensitive configuration
- Message IDs are used to track question/answer pairs
- The bot ignores messages that are not replies to its own questions

## License

ISC

## Author

qpd-v

## Version

0.3.0 — First release with the shared HTTP daemon, stdio wrapper (`bin/mcp-client.sh`), state directory (`/tmp/mcp-communicator-telegram-$USER`), and reply-only question routing.
