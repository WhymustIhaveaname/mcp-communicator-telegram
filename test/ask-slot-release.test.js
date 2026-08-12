// Regression: a pending ask_user must give its per-session budget slot back
// when the call ends WITHOUT a Telegram reply. Observed failure before this
// test existed: Claude Code aborted an ask_user client-side after ~12h; the
// daemon kept awaiting the never-resolved reply promise, so askUser's
// `finally` never ran and the session could never call ask_user again for the
// daemon's remaining lifetime (6+ days).
//
// The daemon needs a live Telegram bot, so instead of booting it we model the
// exact control flow that leaked: reserve a slot, await a promise only a reply
// can settle, and let an AbortSignal / TTL end the wait.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PendingAskBudget } = require('../build/pending-ask-budget.js');

class AskAbortedError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AskAbortedError';
    this.kind = kind;
  }
}

// Mirrors src/index.ts askUser(): reserve → await reply/abort/ttl → finally release.
function askUserLike(budget, sessionId, { signal, ttlMs = 0 } = {}) {
  const release = budget.reserve(sessionId);
  let resolveReply;
  let onAbort;
  let timer;

  const replyPromise = new Promise((resolve, reject) => {
    resolveReply = resolve;
    if (signal) {
      if (signal.aborted) {
        reject(signal.reason ?? new AskAbortedError('client_gone', 'aborted'));
      } else {
        onAbort = () => reject(signal.reason ?? new AskAbortedError('client_gone', 'aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    if (ttlMs > 0) {
      timer = setTimeout(
        () => reject(new AskAbortedError('timeout', `no reply within ${ttlMs} ms`)),
        ttlMs,
      );
    }
  });

  const settled = replyPromise.finally(() => {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    release();
  });

  return { promise: settled, reply: (text) => resolveReply(text) };
}

test('a reply releases the slot', async () => {
  const budget = new PendingAskBudget(1);
  const ask = askUserLike(budget, 'session-a');
  assert.equal(budget.pending('session-a'), 1);

  ask.reply('answer');
  assert.equal(await ask.promise, 'answer');
  assert.equal(budget.pending('session-a'), 0);
});

test('client disconnect releases the slot (the 12h-timeout bug)', async () => {
  const budget = new PendingAskBudget(1);
  const controller = new AbortController();
  const ask = askUserLike(budget, 'session-a', { signal: controller.signal });

  assert.equal(budget.pending('session-a'), 1);
  assert.throws(() => budget.reserve('session-a'), /ask_user blocked/);

  controller.abort(new AskAbortedError('client_gone', 'MCP client closed the connection'));
  await assert.rejects(ask.promise, { name: 'AskAbortedError', kind: 'client_gone' });

  // The whole point: the session can ask again without restarting the daemon.
  assert.equal(budget.pending('session-a'), 0);
  const next = askUserLike(budget, 'session-a');
  assert.equal(budget.pending('session-a'), 1);
  next.reply('ok');
  await next.promise;
});

test('an explicit cancellation releases the slot', async () => {
  const budget = new PendingAskBudget(1);
  const controller = new AbortController();
  const ask = askUserLike(budget, 'session-a', { signal: controller.signal });

  controller.abort(new AskAbortedError('cancelled', 'client cancelled the request'));
  await assert.rejects(ask.promise, { kind: 'cancelled' });
  assert.equal(budget.pending('session-a'), 0);
});

test('the backstop TTL releases the slot when nothing else does', async () => {
  const budget = new PendingAskBudget(1);
  const ask = askUserLike(budget, 'session-a', { ttlMs: 20 });

  assert.equal(budget.pending('session-a'), 1);
  await assert.rejects(ask.promise, { kind: 'timeout' });
  assert.equal(budget.pending('session-a'), 0);
});

test('aborting one session does not free another session slot', async () => {
  const budget = new PendingAskBudget(1);
  const controller = new AbortController();
  const a = askUserLike(budget, 'session-a', { signal: controller.signal });
  const b = askUserLike(budget, 'session-b');

  controller.abort(new AskAbortedError('client_gone', 'gone'));
  await assert.rejects(a.promise, { kind: 'client_gone' });

  assert.equal(budget.pending('session-a'), 0);
  assert.equal(budget.pending('session-b'), 1);
  b.reply('still mine');
  await b.promise;
});
