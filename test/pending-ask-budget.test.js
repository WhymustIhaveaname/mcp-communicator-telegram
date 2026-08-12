const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_ASK_USER_TIMEOUT_MS,
  PendingAskBudget,
  parseAskTimeoutMs,
  parsePendingAskLimit,
} = require('../build/pending-ask-budget.js');

test('defaults to an unlimited per-session budget', () => {
  assert.equal(parsePendingAskLimit(undefined), Infinity);
  assert.equal(parsePendingAskLimit(''), Infinity);
  assert.equal(parsePendingAskLimit('infinity'), Infinity);
  assert.equal(parsePendingAskLimit('unlimited'), Infinity);
});

test('parses finite limits and rejects malformed values', () => {
  assert.equal(parsePendingAskLimit('0'), 0);
  assert.equal(parsePendingAskLimit('1'), 1);
  assert.throws(() => parsePendingAskLimit('-1'), /nonnegative integer/);
  assert.throws(() => parsePendingAskLimit('1.5'), /nonnegative integer/);
});

test('blocks a second unanswered ask in the same session', () => {
  const budget = new PendingAskBudget(1);
  const release = budget.reserve('session-a');

  assert.equal(budget.pending('session-a'), 1);
  assert.throws(
    () => budget.reserve('session-a'),
    {
      message: 'ask_user blocked for this session: 1 unanswered request(s), ' +
        'limit=1. Wait for the previous ask_user reply before asking another question.',
    },
  );

  release();
  assert.equal(budget.pending('session-a'), 0);
});

test('keeps budgets independent across sessions', () => {
  const budget = new PendingAskBudget(1);
  const releaseA = budget.reserve('session-a');
  const releaseB = budget.reserve('session-b');

  assert.equal(budget.pending('session-a'), 1);
  assert.equal(budget.pending('session-b'), 1);

  releaseA();
  releaseB();
});

test('keeps sessions without an identity unlimited for compatibility', () => {
  assert.doesNotThrow(() => new PendingAskBudget(Infinity).reserve(null));
  assert.doesNotThrow(() => new PendingAskBudget(1).reserve(null));
});

test('release is idempotent and makes the slot reusable', () => {
  const budget = new PendingAskBudget(1);
  const release = budget.reserve('session-a');
  release();
  release();

  const releaseAgain = budget.reserve('session-a');
  assert.equal(budget.pending('session-a'), 1);
  releaseAgain();
});

test('ask_user backstop timeout defaults on and can be disabled', () => {
  assert.equal(parseAskTimeoutMs(undefined), DEFAULT_ASK_USER_TIMEOUT_MS);
  assert.equal(parseAskTimeoutMs(''), DEFAULT_ASK_USER_TIMEOUT_MS);
  assert.equal(parseAskTimeoutMs('0'), 0);
  assert.equal(parseAskTimeoutMs('off'), 0);
  assert.equal(parseAskTimeoutMs('none'), 0);
  assert.equal(parseAskTimeoutMs('1500'), 1500);
  assert.throws(() => parseAskTimeoutMs('-1'), /nonnegative integer/);
  assert.throws(() => parseAskTimeoutMs('12h'), /nonnegative integer/);
});
