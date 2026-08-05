const test = require('node:test');
const assert = require('node:assert/strict');

const {
  migratedChatId,
  telegramErrorMessage,
} = require('../build/telegram-error.js');

test('extracts Telegram migrate_to_chat_id from an API error', () => {
  const error = {
    response: {
      body: {
        parameters: { migrate_to_chat_id: -1004348316573 },
      },
    },
  };
  assert.equal(migratedChatId(error), '-1004348316573');
});

test('rejects malformed migration IDs', () => {
  assert.equal(migratedChatId({ response: { body: { parameters: {
    migrate_to_chat_id: 'not-an-id',
  } } } }), null);
  assert.equal(migratedChatId(new Error('ordinary failure')), null);
});

test('logs only the safe error message', () => {
  const error = Object.assign(new Error('400 group migrated'), {
    request: { href: 'https://api.telegram.org/bot-secret/sendMessage' },
  });
  assert.equal(telegramErrorMessage(error), '400 group migrated');
});
