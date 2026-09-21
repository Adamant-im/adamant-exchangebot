jest.mock('../../modules/DB', () => ({ incomingTxsDb: { find: jest.fn() } }));
jest.mock('../../helpers/messenger', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const db = require('../../modules/DB');
const messenger = require('../../helpers/messenger');
const log = require('../../helpers/log');
const config = require('../../modules/configReader');
const constants = require('../../helpers/const');
const { PHRASE_COLLECTIONS } = require('../../helpers/phrases');
const unknownTxs = require('../../modules/unknownTxs');

const USER = 'U16655734187932477074';

/**
 * Builds a list of previous unparsable messages from this user.
 *
 * @param {number} count How many messages, including the one being handled
 * @param {number} [gapMs] How long before now the previous message arrived
 * @returns {object[]}
 */
function previousMessages(count, gapMs = 0) {
  const now = Date.now();

  return Array.from({ length: count }, (_, index) => ({
    senderId: USER,
    date: index === 0 ? now : now - gapMs,
  }));
}

/**
 * Builds the stored incoming transaction for the message being handled.
 *
 * @returns {object}
 */
function incomingTx() {
  return { _id: 'adm-tx-1', update: jest.fn().mockResolvedValue(undefined) };
}

describe('unknownTxs.chooseReply', () => {
  test('greets a first-time user with the configured welcome message', () => {
    const reply = unknownTxs.chooseReply(1);

    expect(reply).toContain(config.welcome_string);
    expect(reply).toContain('slash');
  });

  test('escalates through the fixed replies for the first few messages', () => {
    expect(unknownTxs.chooseReply(2)).toContain('don’t share a language');
    expect(unknownTxs.chooseReply(3)).toContain('/help');
    expect(unknownTxs.chooseReply(4)).toContain('just want to talk');
  });

  test.each([
    [5, 0],
    [9, 0],
    [10, 1],
    [19, 1],
    [20, 2],
    [30, 3],
    [40, 4],
    [50, 5],
    [500, 5],
  ])('a user with %i messages gets a phrase from collection %i', (count, collectionIndex) => {
    const reply = unknownTxs.chooseReply(count);

    expect(PHRASE_COLLECTIONS[collectionIndex]).toContain(reply);
  });

  test('always returns a non-empty reply', () => {
    for (let count = 1; count <= 60; count += 1) {
      expect(unknownTxs.chooseReply(count)).toBeTruthy();
    }
  });
});

describe('unknownTxs', () => {
  test('replies and marks the message as processed', async () => {
    db.incomingTxsDb.find.mockResolvedValue(previousMessages(1));

    const itx = incomingTx();

    await unknownTxs({ senderId: USER, id: 'adm-tx-1' }, itx);

    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining(config.welcome_string));
    expect(itx.update).toHaveBeenCalledWith({ isProcessed: true }, true);
  });

  test('looks only at this user’s unparsable messages from the last day, newest first', async () => {
    db.incomingTxsDb.find.mockResolvedValue(previousMessages(1));

    await unknownTxs({ senderId: USER, id: 'adm-tx-1' }, incomingTx());

    const [query, options] = db.incomingTxsDb.find.mock.calls[0];

    expect(query.senderId).toBe(USER);
    expect(query.messageDirective).toBe('unknown');
    expect(query.date.$gt).toBeGreaterThan(Date.now() - constants.DAY - 1000);
    expect(options).toEqual({ sort: { date: -1 } });
  });

  test('treats a user who returns after a long pause as a new conversation', async () => {
    // Ten earlier messages, but the most recent one was three hours ago.
    db.incomingTxsDb.find.mockResolvedValue(previousMessages(10, 3 * 60 * 60 * 1000));

    await unknownTxs({ senderId: USER, id: 'adm-tx-1' }, incomingTx());

    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining(config.welcome_string));
  });

  test('escalates within an ongoing conversation', async () => {
    db.incomingTxsDb.find.mockResolvedValue(previousMessages(2, 60 * 1000));

    await unknownTxs({ senderId: USER, id: 'adm-tx-1' }, incomingTx());

    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('don’t share a language'));
  });

  test('logs and moves on when the lookup fails', async () => {
    db.incomingTxsDb.find.mockRejectedValue(new Error('db down'));

    await expect(unknownTxs({ senderId: USER, id: 'adm-tx-1' }, incomingTx())).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Error while replying to an unknown message'));
  });
});
