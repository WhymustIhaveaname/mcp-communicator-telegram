// node-telegram-bot-api schedules the next getUpdates from the *previous*
// one's `.finally()`, and sets no socket timeout. So if a poll's TCP
// connection dies without RST — the classic case is the host switching
// interfaces, leaving the old source IP black-holed — the promise never
// settles, `.finally()` never runs, and the poll loop stops forever. Nothing
// reports it: `polling_error` doesn't fire, and outbound calls keep working
// because each one dials a fresh connection over the new route. The daemon
// looks healthy and notify_user succeeds while every ask_user reply is
// silently dropped. (Observed 2026-08-17: a wedged poll socket sat at
// Send-Q 245 B / 12 retransmits for hours, so every ask_user in every session
// hung until the daemon was killed by hand.)
//
// So: stamp every settled getUpdates, and if the gap ever exceeds a healthy
// long poll by a wide margin, cancel the in-flight request. Cancelling makes
// the pending promise settle, which lets the library's own `.finally()` fire
// and reschedule — on a fresh connection. We only call startPolling() if that
// self-rescheduling did not happen, since a second loop would double-consume
// updates and fight itself for the token.

/** The slice of node-telegram-bot-api the watchdog actually touches. */
export interface PollingBot {
  getUpdates(...args: any[]): Promise<any>;
  stopPolling(options?: { cancel?: boolean; reason?: string }): Promise<any>;
  startPolling(): Promise<any>;
  isPolling(): boolean;
}

export interface PollingWatchdogOptions {
  /** Idle time after which the poll loop counts as wedged. */
  stallMs: number;
  /** How often to test for a stall. */
  intervalMs: number;
  /** How long to let the cancelled poll reschedule itself before intervening. */
  rescheduleGraceMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface PollingWatchdog {
  /** Run one stall test. Exposed so tests can drive it without a timer. */
  check(): Promise<void>;
  /** Start the periodic stall test. */
  start(): void;
  /** Stop the periodic stall test. */
  stop(): void;
  /** ms since the last settled getUpdates. */
  idleMs(): number;
}

const DEFAULT_RESCHEDULE_GRACE_MS = 2000;

/**
 * Wrap `bot.getUpdates` so every settled poll is stamped, and hand back a
 * watchdog that unwedges the poll loop when those stamps stop arriving.
 */
export function createPollingWatchdog(
  bot: PollingBot,
  options: PollingWatchdogOptions,
): PollingWatchdog {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => console.error(message));
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const rescheduleGraceMs = options.rescheduleGraceMs ?? DEFAULT_RESCHEDULE_GRACE_MS;

  let lastPollSettledAt = now();
  let restarting = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stamp = () => { lastPollSettledAt = now(); };

  const originalGetUpdates = bot.getUpdates.bind(bot);
  bot.getUpdates = (...args: any[]) =>
    originalGetUpdates(...args).then(
      (result: any) => { stamp(); return result; },
      (error: any) => { stamp(); throw error; },
    );

  const idleMs = () => now() - lastPollSettledAt;

  const check = async (): Promise<void> => {
    if (restarting) return;
    const idle = idleMs();
    if (idle < options.stallMs) return;

    restarting = true;
    log(
      `Polling wedged: no getUpdates settled for ${idle} ms ` +
      `(limit ${options.stallMs} ms); cancelling the in-flight poll`,
    );
    try {
      await bot.stopPolling({ cancel: true, reason: 'polling stall watchdog' });
      await sleep(rescheduleGraceMs);
      if (bot.isPolling()) {
        log('Polling resumed on its own after cancel');
      } else {
        await bot.startPolling();
        log('Polling restarted by stall watchdog');
      }
    } catch (error: unknown) {
      // Leave the stamp fresh anyway: retrying every intervalMs against a
      // backend that is refusing us would just spam Telegram.
      log(`Polling stall watchdog failed to restart polling: ${String(error)}`);
    } finally {
      stamp();
      restarting = false;
    }
  };

  return {
    check,
    idleMs,
    start() {
      if (timer) return;
      timer = setInterval(() => { void check(); }, options.intervalMs);
      // Never hold the event loop open just to run the watchdog.
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
