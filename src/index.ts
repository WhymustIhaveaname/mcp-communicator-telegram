#!/usr/bin/env node
import TelegramBot = require('node-telegram-bot-api');
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';
import * as crypto from 'crypto';
import * as dns from 'dns';
import archiver from 'archiver';
import ignore from 'ignore';

// api.telegram.org resolves to both A and AAAA records. When the host's
// IPv6 route is dead but DNS still hands out the AAAA first (default OS
// order), every Telegram HTTPS call ends in `EFATAL: AggregateError` and
// the bot stops working. Pinning IPv4-first sidesteps that.
dns.setDefaultResultOrder('ipv4first');

// Load .env from the package root so the daemon works regardless of cwd.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Enable proper file content-type handling
process.env.NTBA_FIX_350 = '1';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HTTP_PORT_START = parseInt(process.env.MCP_HTTP_PORT ?? '13579', 10);
const HTTP_PORT_TRIES = 10;
const HTTP_HOST = process.env.MCP_HTTP_HOST ?? '127.0.0.1';

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  throw new Error('TELEGRAM_TOKEN and CHAT_ID are required in .env file');
}

// STATE_DIR is keyed only by sha256(TELEGRAM_TOKEN). Telegram's getUpdates is
// mutually exclusive at the bot-token level, so one daemon per token is the
// physical maximum; we therefore key by token alone and let any user with the
// same token reuse the same daemon. Different bots get different hashes and
// run side by side. The wrapper sets group=sudo + setgid (2770) so all sudo
// members can share the dir; new files inherit gid=sudo and get mode 0o660.
const instanceHash = crypto
  .createHash('sha256')
  .update(TELEGRAM_TOKEN)
  .digest('hex')
  .slice(0, 8);
const STATE_DIR = path.join(
  '/tmp',
  `mcp-communicator-telegram-${instanceHash}`,
);
const PID_FILE = path.join(STATE_DIR, 'server.pid');
const PORT_FILE = path.join(STATE_DIR, 'server.port');

const validatedChatId = CHAT_ID as string;
let bot: TelegramBot | null = null;

interface PendingReply {
  text: string;
  chatId: number;
  messageId: number;
}
const pendingQuestions = new Map<string, (reply: PendingReply) => void>();

async function initializeBot() {
  try {
    bot = new TelegramBot(TELEGRAM_TOKEN!, {
      polling: true,
      filepath: false
    });

    const handleMessage = (msg: TelegramBot.Message) => {
      console.error('Received message:', {
        chatId: msg.chat.id.toString(),
        expectedChatId: validatedChatId,
        text: msg.text,
        replyToMessage: msg.reply_to_message?.text
      });

      if (msg.chat.id.toString() !== validatedChatId || !msg.text) {
        console.error('Message rejected: chat ID mismatch or no text');
        return;
      }

      let questionId = null;

      if (msg.reply_to_message?.text) {
        const match = msg.reply_to_message.text.match(/#([a-z0-9]+)\n/);
        if (match) {
          questionId = match[1];
        }
      }

      console.error('Question ID (from Reply only):', questionId);
      console.error('Pending questions:', Array.from(pendingQuestions.keys()));

      if (questionId && pendingQuestions.has(questionId)) {
        console.error('Found matching question with ID:', questionId);
        const resolver = pendingQuestions.get(questionId)!;
        resolver({
          text: msg.text,
          chatId: msg.chat.id,
          messageId: msg.message_id,
        });
        pendingQuestions.delete(questionId);
        console.error('Question resolved and removed from pending');
      } else {
        console.error('No matching question found for this response');
      }
    };

    bot.on('message', handleMessage);

    bot.on('polling_error', (error: Error) => {
      if (error.message.includes('409 Conflict')) {
        return;
      }
      console.error('Polling error:', error.message);
    });

    const botInfo = await bot.getMe();
    console.error('Bot initialized successfully:', botInfo.username);

    return true;
  } catch (error: any) {
    console.error('Error initializing bot:', error?.message || 'Unknown error');
    return false;
  }
}

interface AskUserParams {
  question: string;
}

interface NotifyUserParams {
  message: string;
}

async function notifyUser(params: NotifyUserParams): Promise<void> {
  if (!bot) {
    throw new Error('Bot not initialized');
  }

  const { message } = params;

  try {
    await bot.sendMessage(parseInt(validatedChatId), message);
    console.error('Notification sent successfully');
  } catch (error: any) {
    console.error('Error in notifyUser:', error);
    throw new Error(`Failed to send notification: ${error.message}`);
  }
}

async function askUser(params: AskUserParams): Promise<PendingReply> {
  if (!bot) {
    throw new Error('Bot not initialized');
  }

  const { question } = params;
  const questionId = Math.random().toString(36).substring(7);

  console.error('Asking question with ID:', questionId);

  try {
    await bot.sendMessage(parseInt(validatedChatId), `#${questionId}\n${question}`, {
      reply_markup: {
        force_reply: true,
        selective: true
      }
    });
    console.error('Question sent successfully');

    const reply = await new Promise<PendingReply>((resolve) => {
      pendingQuestions.set(questionId, resolve);
    });

    console.error('Received response:', reply.text);
    return reply;
  } catch (error: any) {
    console.error('Error in askUser:', error);
    throw new Error(`Failed to get response: ${error.message}`);
  }
}

// Acknowledge that the user's reply made it back to Claude Code by reacting
// to *their* message with 👌. The contract callers rely on: if you see the
// 👌 in Telegram, the ask_user tool call has unblocked on the CC side. So
// this MUST run only after the JSON-RPC response is flushed to the wrapper.
async function reactWithOk(chatId: number, messageId: number): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMessageReaction`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '👌' }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<no body>');
    throw new Error(`setMessageReaction ${res.status}: ${body}`);
  }
}

async function sendFile(params: { filePath: string }): Promise<void> {
  if (!bot) {
    throw new Error('Bot not initialized');
  }

  const { filePath } = params;

  try {
    const fileStream = fs.createReadStream(filePath);
    await bot.sendDocument(parseInt(validatedChatId), fileStream, {}, {
      contentType: 'application/octet-stream',
      filename: path.basename(filePath)
    });
    console.error('File sent successfully');
  } catch (error: any) {
    console.error('Error in sendFile:', error);
    throw new Error(`Failed to send file: ${error.message}`);
  }
}

async function zipProject(params: { directory?: string } = {}): Promise<void> {
  const workingDir = params.directory || process.cwd();
  const projectName = path.basename(workingDir);
  const ig = ignore();
  const gitignorePath = path.join(workingDir, '.gitignore');
  const gitignoreContent = fs.existsSync(gitignorePath) ?
    fs.readFileSync(gitignorePath, 'utf8') :
    '';
  ig.add(gitignoreContent);

  const outputPath = path.join(workingDir, `${projectName}-project.zip`);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    output.on('close', () => {
      console.error(`Zipped ${archive.pointer()} total bytes`);
      resolve();
    });

    archive.on('error', (err: Error) => {
      reject(err);
    });

    archive.pipe(output);

    const addFilesFromDirectory = (dirPath: string) => {
      const files = fs.readdirSync(dirPath);

      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        const relativePath = path.relative(workingDir, fullPath);

        if (relativePath.startsWith('.git')) {
          continue;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          addFilesFromDirectory(fullPath);
        } else {
          if (!ig.ignores(relativePath)) {
            archive.file(fullPath, { name: relativePath });
          }
        }
      }
    };

    addFilesFromDirectory(workingDir);
    archive.finalize();
  });

  const stats = fs.statSync(outputPath);
  const TWO_GB = 2 * 1024 * 1024 * 1024;

  if (stats.size > TWO_GB) {
    fs.unlinkSync(outputPath);
    throw new Error('File size exceeds 2GB limit. Please implement file splitting or reduce the project size.');
  }
}

// JSON-RPC dispatcher result. `postCommit` runs after the HTTP response has
// been flushed to the wrapper, so callers can schedule effects that must be
// observable to the user only AFTER Claude Code receives the tool result.
type DispatchResult = {
  response: any;
  postCommit?: () => Promise<void>;
};

// JSON-RPC dispatcher: returns the response object, or null for notifications.
async function dispatchRequest(request: any): Promise<DispatchResult | null> {
  // JSON-RPC notifications have no `id` field and MUST NOT receive a response.
  if (!('id' in request)) {
    return null;
  }

  switch (request.method) {
    case 'initialize':
      return {
        response: {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: {
              name: "mcp-communicator-telegram",
              version: "0.3.1"
            },
            capabilities: {
              tools: {
                listTools: true,
                callTool: true
              }
            },
            instructions: "Human-in-the-loop bridge to a real person over a Telegram chat."
          }
        }
      };

    case 'tools/list':
      return {
        response: {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            tools: [
            {
              name: "ask_user",
              description: "Ask the user a question via Telegram and wait for their response (blocks you until the user replies)",
              inputSchema: {
                type: "object",
                properties: {
                  question: {
                    type: "string",
                    description: "The question to ask the user"
                  }
                },
                required: ["question"]
              }
            },
            {
              name: "notify_user",
              description: "Send a notification message to the user via Telegram (you will not receive a reply)",
              inputSchema: {
                type: "object",
                properties: {
                  message: {
                    type: "string",
                    description: "The message to send to the user"
                  }
                },
                required: ["message"]
              }
            },
            {
              name: "send_file",
              description: "Send a file to the user via Telegram",
              inputSchema: {
                type: "object",
                properties: {
                  filePath: {
                    type: "string",
                    description: "The path to the file to send"
                  }
                },
                required: ["filePath"]
              }
            },
            {
              name: "zip_project",
              description: "Zip a project directory and send it to the user",
              inputSchema: {
                type: "object",
                properties: {
                  directory: {
                    type: "string",
                    description: "Directory to zip (defaults to current working directory)"
                  }
                },
                required: []
              }
            }
            ]
          }
        }
      };

    case 'tools/call':
      try {
        let result: any;
        let postCommit: (() => Promise<void>) | undefined;
        switch (request.params.name) {
          case 'ask_user': {
            const reply = await askUser(request.params.arguments);
            result = { content: [{ type: "text", text: reply.text }] };
            // Schedule the 👌 reaction for AFTER the response is flushed —
            // see DispatchResult docstring and reactWithOk's contract.
            postCommit = async () => {
              try {
                await reactWithOk(reply.chatId, reply.messageId);
              } catch (err: any) {
                console.error('Failed to react with 👌:', err?.message ?? err);
              }
            };
            break;
          }
          case 'notify_user': {
            await notifyUser(request.params.arguments);
            result = { content: [{ type: "text", text: "Notification sent successfully. This is a one-way channel — you will NOT receive a user reply through this tool. If you need a response, use ask_user instead." }] };
            break;
          }
          case 'send_file': {
            await sendFile(request.params.arguments);
            result = { content: [{ type: "text", text: "File sent successfully" }] };
            break;
          }
          case 'zip_project': {
            const workingDir = request.params.arguments?.directory || process.cwd();
            const projectName = path.basename(workingDir);
            const zipFilePath = path.join(workingDir, `${projectName}-project.zip`);

            try {
              if (fs.existsSync(zipFilePath)) {
                fs.unlinkSync(zipFilePath);
              }
            } catch (error) {
              console.error('Error cleaning up existing zip file:', error);
            }

            try {
              await zipProject(request.params.arguments);
              await sendFile({ filePath: zipFilePath });
              if (fs.existsSync(zipFilePath)) {
                fs.unlinkSync(zipFilePath);
              }
              result = { content: [{ type: "text", text: "Project zipped and sent successfully" }] };
            } catch (error) {
              try {
                if (fs.existsSync(zipFilePath)) {
                  fs.unlinkSync(zipFilePath);
                }
              } catch (cleanupError) {
                console.error('Error cleaning up zip file after error:', cleanupError);
              }
              throw error;
            }
            break;
          }
          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
        return {
          response: { jsonrpc: "2.0", id: request.id, result },
          postCommit,
        };
      } catch (error: any) {
        return {
          response: {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32000, message: error.message }
          }
        };
      }

    default:
      return {
        response: {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` }
        }
      };
  }
}

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
        const dispatched = await dispatchRequest(request);
        if (dispatched === null) {
          res.writeHead(202);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // res.end(data, cb): cb fires once the body is flushed to the OS
          // socket, which is the closest hook we have to "wrapper has the
          // bytes in hand". postCommit must not run before this.
          res.end(JSON.stringify(dispatched.response), () => {
            dispatched.postCommit?.();
          });
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

const cleanupState = () => {
  // Only delete state files if we still own them. A leaked / zombie daemon
  // exiting must not wipe the live daemon's PID/PORT (they may have been
  // overwritten by a successor). TOCTOU race here is benign: worst case we
  // skip a cleanup we should have done, ensure_daemon recovers next spawn.
  try {
    const recordedPid = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (recordedPid !== String(process.pid)) return;
  } catch {
    return;
  }
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

async function main() {
  const success = await initializeBot();
  if (!success) {
    console.error('Failed to initialize bot, exiting...');
    process.exit(1);
  }
  const { port } = await startHttpServer();

  // mode 0o2770 = setgid + group rwx so other sudo members can share the dir
  // (see STATE_DIR keying comment). When the wrapper spawned us, it already
  // did mkdir + chgrp sudo + chmod 2770, so this path is normally a no-op;
  // the explicit mode here is for the standalone-launch case.
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o2770 });
  fs.writeFileSync(PID_FILE, `${process.pid}\n`, { mode: 0o660 });
  fs.writeFileSync(PORT_FILE, `${port}\n`, { mode: 0o660 });
  console.error(`State recorded: pid=${process.pid} port=${port} in ${STATE_DIR}`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
