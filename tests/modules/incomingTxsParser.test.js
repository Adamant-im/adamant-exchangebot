jest.mock('../../modules/DB', () => ({
  incomingTxsDb: jest.fn(),
  paymentsDb: { findOne: jest.fn(), find: jest.fn() },
}));
jest.mock('../../modules/Store', () => ({ updateLastProcessedBlockHeight: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../helpers/messenger', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../modules/exchangeTxs', () => jest.fn().mockResolvedValue(undefined));
jest.mock('../../modules/commandTxs', () => jest.fn().mockResolvedValue(undefined));
jest.mock('../../modules/unknownTxs', () => jest.fn().mockResolvedValue(undefined));
jest.mock('adamant-api', () => {
  const actual = jest.requireActual('adamant-api');

  return { ...actual, decodeMessage: jest.fn() };
});
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const USER = 'U16655734187932477074';

/**
 * Every test starts with a fresh module registry, because the parser keeps an
 * in-memory cache of the transactions it has already handled. These bindings are
 * re-resolved in `beforeEach` so the test and the parser share one set of mocks.
 */
let txParser;
let db;
let Store;
let notify;
let messenger;
let exchangeTxs;
let commandTxs;
let unknownTxs;
let log;
let config;
let decodeMessage;

/** Incoming-transaction documents the parser created during a test. */
let created;

/**
 * Builds an ADAMANT chat transaction.
 *
 * @param {object} [overrides] Fields to change
 * @returns {object}
 */
function chatTx(overrides = {}) {
  return {
    id: `adm-tx-${Math.floor(Math.random() * 1e9)}`,
    senderId: USER,
    senderPublicKey: 'a'.repeat(64),
    recipientId: 'U14172822264918400879',
    amount: 0,
    fee: 500000,
    type: 8,
    timestamp: 284777920,
    height: 54632450,
    asset: { chat: { message: 'encrypted', own_message: 'nonce', type: 1 } },
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetModules();
  created = [];

  db = require('../../modules/DB');
  Store = require('../../modules/Store');
  notify = require('../../helpers/notify');
  messenger = require('../../helpers/messenger');
  exchangeTxs = require('../../modules/exchangeTxs');
  commandTxs = require('../../modules/commandTxs');
  unknownTxs = require('../../modules/unknownTxs');
  log = require('../../helpers/log');
  config = require('../../modules/configReader');
  ({ decodeMessage } = require('adamant-api'));

  db.incomingTxsDb = jest.fn().mockImplementation(function (data) {
    Object.assign(this, data);
    this.save = jest.fn().mockResolvedValue(this._id);
    this.update = jest.fn().mockImplementation(async (fields) => Object.assign(this, fields));
    created.push(this);
  });
  db.incomingTxsDb.findOne = jest.fn().mockResolvedValue(null);
  db.incomingTxsDb.find = jest.fn().mockResolvedValue([]);
  db.incomingTxsDb.countDocuments = jest.fn().mockResolvedValue(0);
  db.paymentsDb.findOne = jest.fn().mockResolvedValue(null);
  db.paymentsDb.find = jest.fn().mockResolvedValue([]);

  decodeMessage.mockReturnValue('');
  messenger.sendMessage.mockResolvedValue(true);

  // Required after resetModules so each test gets a parser with an empty cache.
  txParser = require('../../modules/incomingTxsParser');
});

describe('incomingTxsParser — routing', () => {
  test('ignores a transaction that is not addressed to the bot', async () => {
    decodeMessage.mockReturnValue('/help');

    await txParser(chatTx({ recipientId: 'U00000000000000000000' }));

    expect(commandTxs).not.toHaveBeenCalled();
    expect(exchangeTxs).not.toHaveBeenCalled();
    expect(unknownTxs).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  test('ignores a transaction authored by the bot itself', async () => {
    decodeMessage.mockReturnValue('/help');

    await txParser(chatTx({ senderId: config.address }));

    expect(commandTxs).not.toHaveBeenCalled();
    expect(exchangeTxs).not.toHaveBeenCalled();
    expect(unknownTxs).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  test('routes a slash command to the command handler', async () => {
    decodeMessage.mockReturnValue('/help');

    await txParser(chatTx());

    expect(commandTxs).toHaveBeenCalledWith('/help', expect.anything(), expect.anything());
    expect(created[0].messageDirective).toBe('command');
  });

  test('routes an ADM transfer to the exchange handler', async () => {
    decodeMessage.mockReturnValue('BTC');

    await txParser(chatTx({ amount: 100000000 }));

    expect(exchangeTxs).toHaveBeenCalled();
    expect(created[0].messageDirective).toBe('exchange');
  });

  test('routes a transfer announced in a rich message to the exchange handler', async () => {
    decodeMessage.mockReturnValue('{"type":"eth_transaction","amount":"0.5","hash":"0xabc","comments":"ADM"}');

    await txParser(chatTx());

    expect(exchangeTxs).toHaveBeenCalled();
    expect(created[0].messageDirective).toBe('exchange');
  });

  test('routes anything else to the small-talk handler', async () => {
    decodeMessage.mockReturnValue('hello there');

    await txParser(chatTx());

    expect(unknownTxs).toHaveBeenCalled();
    expect(created[0].messageDirective).toBe('unknown');
  });

  test('accepts "help" without a slash and records the correction', async () => {
    decodeMessage.mockReturnValue('help');

    await txParser(chatTx());

    expect(commandTxs).toHaveBeenCalledWith('/help', expect.anything(), expect.anything());
    expect(created[0].commandFix).toBe('help');
  });

  test('accepts the singular "/balance"', async () => {
    decodeMessage.mockReturnValue('/balance');

    await txParser(chatTx());

    expect(commandTxs).toHaveBeenCalledWith('/balances', expect.anything(), expect.anything());
    expect(created[0].commandFix).toBe('balance');
  });
});

describe('incomingTxsParser — de-duplication', () => {
  test('processes the same transaction only once', async () => {
    decodeMessage.mockReturnValue('/help');

    const tx = chatTx();

    await txParser(tx);
    await txParser(tx);

    expect(commandTxs).toHaveBeenCalledTimes(1);
  });

  test('ignores a transaction that is already stored', async () => {
    db.incomingTxsDb.findOne.mockResolvedValue({ txid: 'adm-tx-1', height: 1, update: jest.fn() });
    decodeMessage.mockReturnValue('/help');

    await txParser(chatTx());

    expect(commandTxs).not.toHaveBeenCalled();
  });

  test('fills in the block details of a transaction first seen over the socket', async () => {
    decodeMessage.mockReturnValue('/help');

    const tx = chatTx({ height: undefined });

    await txParser(tx);

    const stored = created[0];

    stored.update.mockClear();
    db.incomingTxsDb.findOne.mockResolvedValue(stored);

    await txParser({ ...tx, height: 54632450, blockId: 'block-1', confirmations: 1 });

    expect(stored.update).toHaveBeenCalledWith(expect.objectContaining({ height: 54632450 }), true);
    expect(Store.updateLastProcessedBlockHeight).toHaveBeenCalledWith(54632450);
  });
});

describe('incomingTxsParser — deposits', () => {
  test('records an ADM top-up without treating it as an exchange', async () => {
    decodeMessage.mockReturnValue('deposit');

    await txParser(chatTx({ amount: 100000000 }));

    expect(exchangeTxs).not.toHaveBeenCalled();
    expect(created[0].isDeposit).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('top-up transfer'), 'info');
  });

  test('refuses a top-up claimed in a rich message by an ordinary user, since nothing proves it', async () => {
    decodeMessage.mockReturnValue('{"type":"btc_transaction","amount":"1","hash":"abc","comments":"deposit"}');

    await txParser(chatTx());

    // No on-chain value and no operator identity: it goes through the normal pipeline,
    // which validates the claimed transfer, rather than being recorded as a top-up.
    expect(created[0].isDeposit).toBeUndefined();
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining('top-up transfer'), 'info');
    expect(exchangeTxs).toHaveBeenCalled();
  });

  test('recognizes a top-up announced in a rich message by the operator', async () => {
    const operator = 'U11111111111111111111';

    config.adamant_notify = operator;

    try {
      decodeMessage.mockReturnValue('{"type":"btc_transaction","amount":"1","hash":"abc","comments":"deposit"}');

      await txParser(chatTx({ senderId: operator }));

      expect(exchangeTxs).not.toHaveBeenCalled();
      expect(created[0].isDeposit).toBe(true);
    } finally {
      config.adamant_notify = '';
    }
  });

  test('does not treat a plain "deposit" message with no transfer as a top-up', async () => {
    decodeMessage.mockReturnValue('deposit');

    await txParser(chatTx());

    expect(created[0].isDeposit).toBeUndefined();
    expect(unknownTxs).toHaveBeenCalled();
  });
});

describe('incomingTxsParser — spam control', () => {
  test('bans a user who has written too much, and answers only once', async () => {
    db.incomingTxsDb.countDocuments.mockResolvedValue(100);
    decodeMessage.mockReturnValue('hello');

    await txParser(chatTx());

    expect(created[0].isSpam).toBe(true);
    expect(unknownTxs).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('spammer'), 'warn');
    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('banned'));
  });

  test('still processes a transfer from a user who trips the limit, so the funds are not stranded', async () => {
    db.incomingTxsDb.countDocuments.mockResolvedValue(100);
    decodeMessage.mockReturnValue('BTC');

    await txParser(chatTx({ amount: 100000000 }));

    expect(created[0].isSpam).toBe(true);
    // Throttling applies to chatter, not to money: a payment record must still be created
    // so the transfer can be validated, paid out or refunded.
    expect(exchangeTxs).toHaveBeenCalled();
  });

  test('still processes a transfer from a user who is already flagged', async () => {
    db.incomingTxsDb.countDocuments.mockResolvedValue(100);
    db.incomingTxsDb.findOne.mockImplementation(async (query) => (query.isSpam ? { senderId: USER } : null));
    decodeMessage.mockReturnValue('BTC');

    await txParser(chatTx({ amount: 100000000 }));

    expect(exchangeTxs).toHaveBeenCalled();
  });

  test('refuses a command from a user who is already flagged', async () => {
    db.incomingTxsDb.countDocuments.mockResolvedValue(100);
    db.incomingTxsDb.findOne.mockImplementation(async (query) => (query.isSpam ? { senderId: USER } : null));
    decodeMessage.mockReturnValue('/balances');

    await txParser(chatTx());

    expect(commandTxs).not.toHaveBeenCalled();
  });

  test('does not repeat the ban message to a user who is already flagged', async () => {
    db.incomingTxsDb.countDocuments.mockResolvedValue(100);
    db.incomingTxsDb.findOne.mockImplementation(async (query) => (query.isSpam ? { senderId: USER } : null));
    decodeMessage.mockReturnValue('hello');

    await txParser(chatTx());

    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining('spammer'), 'warn');
  });
});

describe('incomingTxsParser — clarifications', () => {
  test('routes a plain answer to the payment that is waiting for it', async () => {
    const payToUpdate = { _id: 'old-tx', inUpdateState: 'outCurrency', inAmountMessage: 1, inCurrency: 'ADM' };

    db.paymentsDb.findOne.mockResolvedValue(payToUpdate);
    decodeMessage.mockReturnValue('BTC');

    await txParser(chatTx());

    expect(exchangeTxs).toHaveBeenCalledWith(expect.anything(), expect.anything(), payToUpdate);
    expect(created[0].messageDirective).toBe('update');
  });

  test('forgets the waiting payment when a new transfer arrives instead of an answer', async () => {
    const waiting = {
      _id: 'old-tx',
      inUpdateState: 'outCurrency',
      inAmountMessage: 1,
      inCurrency: 'ADM',
      update: jest.fn().mockResolvedValue(undefined),
    };

    db.paymentsDb.findOne.mockResolvedValue(waiting);
    db.paymentsDb.find.mockResolvedValue([waiting]);
    decodeMessage.mockReturnValue('BTC');

    await txParser(chatTx({ amount: 100000000 }));

    expect(waiting.update).toHaveBeenCalledWith({ isIgnored: true, isProcessed: true, inUpdateState: undefined }, true);
    // Treated as a brand new exchange request, with no payment to update.
    expect(exchangeTxs).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('in favour of the new one'), 'warn');
  });
});

describe('incomingTxsParser — decryption', () => {
  test('treats an undecryptable message as unknown instead of crashing', async () => {
    decodeMessage.mockImplementation(() => {
      throw new Error('bad nonce');
    });

    await txParser(chatTx());

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to decrypt the message'));
    expect(unknownTxs).toHaveBeenCalled();
  });

  test('handles a plain transfer that carries no message at all', async () => {
    await txParser(chatTx({ asset: undefined, amount: 100000000 }));

    expect(decodeMessage).not.toHaveBeenCalled();
    expect(exchangeTxs).toHaveBeenCalled();
  });
});
