jest.mock('../../modules/DB', () => ({
  incomingTxsDb: jest.fn(),
  paymentsDb: { findOne: jest.fn(), find: jest.fn() },
}));
jest.mock('../../modules/Store', () => ({ updateLastProcessedBlockHeight: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../helpers/messenger', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../modules/exchangeTxs', () => jest.fn().mockResolvedValue(undefined));
jest.mock('../../modules/depositClaims', () => ({
  markOperatorTopUp: jest.fn().mockResolvedValue(true),
  abandonClaim: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../modules/api', () => ({ getTransaction: jest.fn() }));
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
let depositClaims;
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
  depositClaims = require('../../modules/depositClaims');
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

  test('handles a transaction once when the socket and the poller deliver it at the same moment', async () => {
    // Both arrivals pass the database check before either record is stored; only the
    // in-flight registration, made before the first await, tells them apart.
    decodeMessage.mockReturnValue('BTC');

    const tx = chatTx({ amount: 100000000 });

    await Promise.all([txParser({ ...tx, height: undefined }), txParser(tx)]);

    expect(exchangeTxs).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  test('handles a later delivery of the same transaction once the first one is done', async () => {
    decodeMessage.mockReturnValue('/help');

    const tx = chatTx({ height: undefined });

    await txParser(tx);

    const stored = created[0];

    db.incomingTxsDb.findOne.mockResolvedValue(stored);

    // The in-flight registration is released, so the poller's copy fills in the height.
    await txParser({ ...tx, height: 54632450 });

    expect(Store.updateLastProcessedBlockHeight).toHaveBeenCalledWith(54632450);
  });

  test('looks a transaction up by its primary key', async () => {
    decodeMessage.mockReturnValue('/help');

    const tx = chatTx();

    await txParser(tx);

    // Stored records use the transaction ID as `_id`, which is always indexed.
    expect(db.incomingTxsDb.findOne).toHaveBeenCalledWith({ _id: tx.id });
    expect(db.incomingTxsDb.findOne).not.toHaveBeenCalledWith({ txid: tx.id });
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
      const hash = 'ab'.repeat(32);

      decodeMessage.mockReturnValue(`{"type":"btc_transaction","amount":"1","hash":"${hash}","comments":"deposit"}`);

      await txParser(chatTx({ id: 'adm-topup-1', senderId: operator }));

      expect(exchangeTxs).not.toHaveBeenCalled();
      expect(created[0].isDeposit).toBe(true);
      expect(depositClaims.markOperatorTopUp).toHaveBeenCalledWith('BTC', hash, 'adm-topup-1');
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

  test('still processes /cancel from a flagged user when an exchange is awaiting clarification', async () => {
    db.incomingTxsDb.countDocuments.mockResolvedValue(100);
    db.incomingTxsDb.findOne.mockImplementation(async (query) => (query.isSpam ? { senderId: USER } : null));
    db.paymentsDb.findOne.mockResolvedValue({
      _id: 'pending-payment-1',
      senderId: USER,
      inUpdateState: 'outCurrency',
    });
    decodeMessage.mockReturnValue('/cancel');

    await txParser(chatTx());

    expect(commandTxs).toHaveBeenCalledWith('/cancel', expect.any(Object), expect.any(Object));
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

  test('queues the waiting payment for refund when a new transfer arrives instead of an answer', async () => {
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

    expect(waiting.update).toHaveBeenCalledWith(
      { needToSendBack: true, isBasicChecksPassed: true, inUpdateState: undefined },
      true,
    );
    // Treated as a brand new exchange request, with no payment to update.
    expect(exchangeTxs).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('try to send the previous transfer back'), 'warn');
  });

  test('routes /cancel to the command handler when a payment is awaiting clarification', async () => {
    const waiting = {
      _id: 'old-tx',
      inUpdateState: 'outCurrency',
      inAmountMessage: 1,
      inCurrency: 'ADM',
    };

    db.paymentsDb.findOne.mockResolvedValue(waiting);
    decodeMessage.mockReturnValue('/cancel');

    await txParser(chatTx());

    expect(commandTxs).toHaveBeenCalledWith('/cancel', expect.anything(), expect.anything());
    expect(created[0].messageDirective).toBe('command');
  });

  test('auto-corrects cancel without slash to /cancel and routes to command handler', async () => {
    const waiting = {
      _id: 'old-tx',
      inUpdateState: 'outCurrency',
      inAmountMessage: 1,
      inCurrency: 'ADM',
    };

    db.paymentsDb.findOne.mockResolvedValue(waiting);
    decodeMessage.mockReturnValue('cancel');

    await txParser(chatTx());

    expect(commandTxs).toHaveBeenCalledWith('/cancel', expect.anything(), expect.anything());
    expect(created[0].messageDirective).toBe('command');
    expect(created[0].commandFix).toBe('cancel');
  });
});

describe('incomingTxsParser.replayUnprocessed', () => {
  let api;

  /**
   * Builds a stored incoming record that never finished.
   *
   * @param {object} [overrides] Fields to change
   * @returns {object}
   */
  function storedRecord(overrides = {}) {
    const record = {
      txid: 'adm-tx-stuck',
      senderId: USER,
      messageDirective: 'exchange',
      isProcessed: false,
      date: Date.now() - 10 * 60 * 1000,
      ...overrides,
    };

    record.update = jest.fn().mockImplementation(async (fields) => Object.assign(record, fields));

    return record;
  }

  beforeEach(() => {
    api = require('../../modules/api');
    api.getTransaction.mockResolvedValue({
      success: true,
      transaction: chatTx({ id: 'adm-tx-stuck', amount: 100000000 }),
    });
  });

  test('looks only for records that were stored a while ago and never finished', async () => {
    await txParser.replayUnprocessed();

    const query = db.incomingTxsDb.find.mock.calls[0][0];

    expect(query).toEqual(
      expect.objectContaining({ isProcessed: false, isSpam: { $ne: true }, isDeposit: { $ne: true } }),
    );
    expect(query.date.$lt).toBeLessThan(Date.now());
  });

  test('runs the exchange handler again when it never created the payment', async () => {
    const record = storedRecord();

    db.incomingTxsDb.find.mockResolvedValue([record]);

    await txParser.replayUnprocessed();

    // The transaction is read from the blockchain again rather than trusted from storage.
    expect(api.getTransaction).toHaveBeenCalledWith('adm-tx-stuck', { returnAsset: 1 });
    expect(exchangeTxs).toHaveBeenCalledWith(record, expect.objectContaining({ id: 'adm-tx-stuck' }), undefined);
    expect(record.isProcessed).toBe(true);
  });

  test('never creates a second payment when the handler had already created one', async () => {
    const record = storedRecord();

    db.incomingTxsDb.find.mockResolvedValue([record]);
    db.paymentsDb.findOne.mockResolvedValue({ _id: 'adm-tx-stuck' });

    await txParser.replayUnprocessed();

    expect(exchangeTxs).not.toHaveBeenCalled();
    expect(record.isProcessed).toBe(true);
  });

  test('does not replay small talk or commands, which carry no value', async () => {
    const record = storedRecord({ messageDirective: 'command' });

    db.incomingTxsDb.find.mockResolvedValue([record]);

    await txParser.replayUnprocessed();

    expect(commandTxs).not.toHaveBeenCalled();
    expect(api.getTransaction).not.toHaveBeenCalled();
    expect(record.isProcessed).toBe(true);
  });

  test('skips a clarification that was applied or dropped since', async () => {
    const record = storedRecord({ messageDirective: 'update', payToUpdateId: 'old-payment' });

    db.incomingTxsDb.find.mockResolvedValue([record]);
    db.paymentsDb.findOne.mockResolvedValue({ _id: 'old-payment', inUpdateState: undefined });

    await txParser.replayUnprocessed();

    expect(exchangeTxs).not.toHaveBeenCalled();
    expect(record.isProcessed).toBe(true);
  });

  test('replays a stored /cancel command for a payment awaiting clarification', async () => {
    const record = storedRecord({
      messageDirective: 'command',
      decryptedMessage: '/cancel',
      payToUpdateId: 'old-payment',
    });

    db.incomingTxsDb.find.mockResolvedValue([record]);
    db.paymentsDb.findOne.mockResolvedValue({
      _id: 'old-payment',
      inUpdateState: 'outCurrency',
      senderId: USER,
    });
    api.getTransaction.mockResolvedValue({
      success: true,
      transaction: chatTx({ id: 'adm-tx-stuck' }),
    });

    await txParser.replayUnprocessed();

    expect(api.getTransaction).toHaveBeenCalledWith('adm-tx-stuck', { returnAsset: 1 });
    expect(commandTxs).toHaveBeenCalledWith('/cancel', expect.objectContaining({ id: 'adm-tx-stuck' }), record);
    expect(record.isProcessed).toBe(true);
  });

  test('skips replaying a /cancel command if the payment is no longer awaiting clarification', async () => {
    const record = storedRecord({
      messageDirective: 'command',
      decryptedMessage: '/cancel',
      payToUpdateId: 'old-payment',
    });

    db.incomingTxsDb.find.mockResolvedValue([record]);
    db.paymentsDb.findOne.mockResolvedValue({
      _id: 'old-payment',
      inUpdateState: undefined,
      needToSendBack: true,
    });

    await txParser.replayUnprocessed();

    expect(commandTxs).not.toHaveBeenCalled();
    expect(api.getTransaction).not.toHaveBeenCalled();
    expect(record.isProcessed).toBe(true);
  });

  test('refuses a record whose transaction no longer matches it', async () => {
    const record = storedRecord();

    db.incomingTxsDb.find.mockResolvedValue([record]);
    api.getTransaction.mockResolvedValue({
      success: true,
      transaction: chatTx({ id: 'adm-tx-stuck', recipientId: 'U00000000000000000000' }),
    });

    await txParser.replayUnprocessed();

    expect(exchangeTxs).not.toHaveBeenCalled();
    expect(record.processingFailed).toBe(true);
  });

  test('tries again later when the transaction cannot be read', async () => {
    const record = storedRecord();

    db.incomingTxsDb.find.mockResolvedValue([record]);
    api.getTransaction.mockResolvedValue({ success: false, errorMessage: 'node down' });

    await txParser.replayUnprocessed();

    expect(exchangeTxs).not.toHaveBeenCalled();
    expect(record.isProcessed).toBe(false);
    expect(record.replayAttempts).toBe(1);
  });

  test('hands the record to the operator after too many attempts', async () => {
    const record = storedRecord({ replayAttempts: 5 });

    db.incomingTxsDb.find.mockResolvedValue([record]);

    await txParser.replayUnprocessed();

    expect(exchangeTxs).not.toHaveBeenCalled();
    expect(record.processingFailed).toBe(true);
    expect(record.isProcessed).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('could not process the incoming Tx'), 'error');
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
