// Regression: node-telegram-bot-api chains the next getUpdates off the
// previous one's `.finally()` and sets no socket timeout, so a poll whose TCP
// connection dies without RST leaves a promise that never settles — the loop
// stops for good, with no `polling_error` and no other symptom. Outbound calls
// keep working (each dials a fresh connection), so notify_user looked healthy
// for hours on 2026-08-17 while every ask_user reply was dropped on the floor.
//
// The watchdog stamps settled polls and cancels the in-flight request once
// those stamps stop arriving. These tests drive `check()` directly against a
// fake clock so no timer or real bot is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPollingWatchdog } = require('../build/polling-watchdog.js');

function fakeBot({ pollingAfterCancel = true } = {}) {
  const calls = [];
  let polling = true;
  return {
    calls,
    // Never settles: models the wedged poll.
    getUpdates: () => new Promise(() => {}),
    stopPolling: async (options) => {
      calls.push(['stopPolling', options]);
      polling = pollingAfterCancel;
    },
    startPolling: async () => {
      calls.push(['startPolling']);
      polling = true;
    },
    isPolling: () => polling,
  };
}

function watchdogOn(bot, { stallMs = 90_000 } = {}) {
  let now = 0;
  const logs = [];
  const watchdog = createPollingWatchdog(bot, {
    stallMs,
    intervalMs: 15_000,
    rescheduleGraceMs: 0,
    now: () => now,
    sleep: async () => {},
    log: (message) => logs.push(message),
  });
  return { watchdog, logs, advance: (ms) => { now += ms; } };
}

test('leaves a healthy poll loop alone', async () => {
  const bot = fakeBot();
  const { watchdog, advance } = watchdogOn(bot);

  advance(89_999);
  await watchdog.check();

  assert.deepEqual(bot.calls, []);
});

test('cancels the in-flight poll once the stall limit is passed', async () => {
  const bot = fakeBot();
  const { watchdog, advance } = watchdogOn(bot);

  advance(90_000);
  await watchdog.check();

  assert.deepEqual(bot.calls[0], [
    'stopPolling',
    { cancel: true, reason: 'polling stall watchdog' },
  ]);
});

test('does not start a second loop when cancel already rescheduled one', async () => {
  // The library's own `.finally()` reschedules after a cancel. Calling
  // startPolling() on top of that would double-consume updates.
  const bot = fakeBot({ pollingAfterCancel: true });
  const { watchdog, advance } = watchdogOn(bot);

  advance(90_000);
  await watchdog.check();

  assert.equal(bot.calls.filter(([name]) => name === 'startPolling').length, 0);
});

test('restarts polling when the cancel killed the loop for good', async () => {
  const bot = fakeBot({ pollingAfterCancel: false });
  const { watchdog, advance } = watchdogOn(bot);

  advance(90_000);
  await watchdog.check();

  assert.deepEqual(bot.calls.map(([name]) => name), ['stopPolling', 'startPolling']);
});

test('a settled poll resets the idle clock', async () => {
  const bot = fakeBot();
  let resolvePoll;
  bot.getUpdates = () => new Promise((resolve) => { resolvePoll = resolve; });
  const { watchdog, advance } = watchdogOn(bot);

  const inFlight = bot.getUpdates();
  advance(80_000);
  resolvePoll([]);
  await inFlight;
  assert.equal(watchdog.idleMs(), 0);

  advance(89_999);
  await watchdog.check();
  assert.deepEqual(bot.calls, []);
});

test('a rejected poll also resets the idle clock', async () => {
  const bot = fakeBot();
  let rejectPoll;
  bot.getUpdates = () => new Promise((_resolve, reject) => { rejectPoll = reject; });
  const { watchdog, advance } = watchdogOn(bot);

  const inFlight = bot.getUpdates();
  advance(80_000);
  rejectPoll(new Error('EFATAL: read ETIMEDOUT'));
  await assert.rejects(inFlight, /ETIMEDOUT/);

  assert.equal(watchdog.idleMs(), 0);
});

test('a failed restart does not retry on every tick', async () => {
  const bot = fakeBot({ pollingAfterCancel: false });
  bot.startPolling = async () => { throw new Error('429 Too Many Requests'); };
  const { watchdog, logs, advance } = watchdogOn(bot);

  advance(90_000);
  await watchdog.check();
  const stopsAfterFirst = bot.calls.filter(([name]) => name === 'stopPolling').length;

  advance(15_000);
  await watchdog.check();

  assert.equal(bot.calls.filter(([name]) => name === 'stopPolling').length, stopsAfterFirst);
  assert.ok(logs.some((line) => line.includes('failed to restart polling')));
});
