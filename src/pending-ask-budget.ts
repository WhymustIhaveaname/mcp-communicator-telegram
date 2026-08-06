export const UNLIMITED_PENDING_ASKS = Number.POSITIVE_INFINITY;

export function parsePendingAskLimit(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value || /^(?:inf|infinity|unlimited)$/i.test(value)) {
    return UNLIMITED_PENDING_ASKS;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      'MAX_PENDING_ASK_USER_PER_SESSION must be a nonnegative integer or infinity',
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('MAX_PENDING_ASK_USER_PER_SESSION exceeds the safe integer range');
  }
  return parsed;
}

export class PendingAskBudget {
  private readonly counts = new Map<string, number>();

  constructor(readonly limit: number) {
    if (limit !== UNLIMITED_PENDING_ASKS && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new Error('pending ask_user limit must be a nonnegative integer or infinity');
    }
  }

  reserve(sessionId: string | null): () => void {
    // Wrappers started before session IDs were introduced must keep working.
    // They remain unlimited until their MCP connection is restarted.
    if (this.limit === UNLIMITED_PENDING_ASKS || !sessionId) {
      return () => {};
    }

    const current = this.counts.get(sessionId) ?? 0;
    if (current >= this.limit) {
      throw new Error(
        `ask_user blocked for this session: ${current} unanswered ` +
        `request(s), limit=${this.limit}. Wait for the previous ask_user reply ` +
        'before asking another question.',
      );
    }
    this.counts.set(sessionId, current + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.counts.get(sessionId) ?? 1) - 1;
      if (next <= 0) {
        this.counts.delete(sessionId);
      } else {
        this.counts.set(sessionId, next);
      }
    };
  }

  pending(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }
}
