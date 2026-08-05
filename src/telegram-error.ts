type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null
    ? value as UnknownRecord
    : null;
}

export function migratedChatId(error: unknown): string | null {
  const response = asRecord(asRecord(error)?.response);
  const body = asRecord(response?.body);
  const parameters = asRecord(body?.parameters);
  const candidate = parameters?.migrate_to_chat_id;

  if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) {
    return String(candidate);
  }
  if (typeof candidate === 'string' && /^-?\d+$/.test(candidate)) {
    return candidate;
  }
  return null;
}

export function telegramErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const candidate = asRecord(error)?.message;
  return typeof candidate === 'string' ? candidate : 'Unknown error';
}
