jest.mock('../../modules/DB', () => ({ paymentsDb: jest.fn() }));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../helpers/messenger', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../modules/depositClaims', () => ({
  CLAIM_STATUS: {
    AWAITING_CLARIFICATION: 'awaiting-clarification',
    INELIGIBLE: 'ineligible',
    PENDING: 'pending',
  },
  getDepositKey: jest.fn((coin, txid) => `${coin.toLowerCase()}:test:${txid}`),
  registerClaim: jest.fn().mockResolvedValue({ isNew: true }),
  setClaimStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../helpers/cryptos/exchanger', () => ({
  isKnown: jest.fn(),
  isAccepted: jest.fn(),
  isExchanged: jest.fn(),
  isERC20: jest.fn(),
  isFastPayments: jest.fn(),
  hasTicker: jest.fn(),
  isLowerThanMinBalance: jest.fn(),
  getRate: jest.fn(),
  convertCryptos: jest.fn(),
  userDailyValue: jest.fn(),
  getExchangedCryptoList: jest.fn(),
  acceptedCryptoList: 'ADM, BTC, ETH',
  BTC: { FEE: 0.0001 },
  ADM: { FEE: 0.5 },
  USDT: { FEE: 0.005 },
}));
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const db = require('../../modules/DB');
const notify = require('../../helpers/notify');
const messenger = require('../../helpers/messenger');
const exchangerUtils = require('../../helpers/cryptos/exchanger');
const log = require('../../helpers/log');
const config = require('../../modules/configReader');
const { SAT } = require('../../helpers/const');
const exchangeTxs = require('../../modules/exchangeTxs');
const depositClaims = require('../../modules/depositClaims');

const USER = 'U16655734187932477074';

/** Payments created during a test, so assertions can read the one the module built. */
let created;

/**
 * Builds an ADAMANT transaction carrying an exchange request.
 *
 * @param {object} [overrides] Fields to change
 * @returns {object}
 */
function admTx(overrides = {}) {
  return { id: 'adm-tx-1', senderId: USER, amount: 0, timestamp: 284777920, ...overrides };
}

/**
 * Builds the stored incoming transaction for a chat message.
 *
 * @param {string} decryptedMessage The message the user sent
 * @returns {object}
 */
function incomingTx(decryptedMessage) {
  return { _id: 'adm-tx-1', decryptedMessage, update: jest.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  created = [];

  // A stand-in for the payments model: `new paymentsDb(...)` records the document,
  // and `findOne` answers the duplicate check.
  db.paymentsDb = jest.fn().mockImplementation(function (data) {
    Object.assign(this, data);
    this.save = jest.fn().mockResolvedValue(this._id);
    this.update = jest.fn().mockImplementation(async (fields) => Object.assign(this, fields));
    created.push(this);
  });
  db.paymentsDb.findOne = jest.fn().mockResolvedValue(null);
  depositClaims.registerClaim.mockResolvedValue({ isNew: true });

  exchangerUtils.isKnown.mockImplementation((coin) => ['ADM', 'BTC', 'ETH', 'DASH', 'DOGE', 'USDT'].includes(coin));
  exchangerUtils.isAccepted.mockReturnValue(true);
  exchangerUtils.isExchanged.mockReturnValue(true);
  exchangerUtils.isERC20.mockReturnValue(false);
  exchangerUtils.isFastPayments.mockReturnValue(false);
  exchangerUtils.hasTicker.mockReturnValue(true);
  exchangerUtils.isLowerThanMinBalance.mockReturnValue(false);
  exchangerUtils.getRate.mockReturnValue(1);
  exchangerUtils.userDailyValue.mockResolvedValue(0);
  exchangerUtils.getExchangedCryptoList.mockResolvedValue('BTC, ETH or ADM');
  exchangerUtils.convertCryptos.mockImplementation((from, to, amount) => ({
    outAmount: Number(amount),
    exchangePrice: 1,
  }));
});

describe('exchangeTxs — reading the request', () => {
  test('reads an ADM transfer whose comment names the wanted coin', async () => {
    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created[0]).toMatchObject({ inCurrency: 'ADM', outCurrency: 'BTC', inAmountMessage: 100 });
  });

  test('reads a transfer made in another blockchain from its rich message', async () => {
    const message = '{"type":"eth_transaction","amount":"0.5","hash":"0xabc","comments":"ADM"}';

    await exchangeTxs(incomingTx(message), admTx());

    expect(created[0]).toMatchObject({
      inCurrency: 'ETH',
      outCurrency: 'ADM',
      inAmountMessage: 0.5,
      inTxid: '0xabc',
    });
  });

  test('trims the punctuation users wrap a ticker in', async () => {
    await exchangeTxs(incomingTx('  "btc".  '), admTx({ amount: 100 * SAT }));

    expect(created[0].outCurrency).toBe('BTC');
  });

  test('applies a clarification to the payment that was waiting for it', async () => {
    const payToUpdate = {
      _id: 'old-tx',
      inUpdateState: 'outCurrency',
      inAmountMessage: 50,
      inCurrency: 'ADM',
      save: jest.fn(),
      update: jest.fn().mockImplementation(async function (fields) {
        Object.assign(this, fields);
      }),
    };

    await exchangeTxs(incomingTx('BTC'), admTx(), payToUpdate);

    expect(db.paymentsDb).not.toHaveBeenCalled();
    expect(payToUpdate.outCurrency).toBe('BTC');
    expect(payToUpdate.inUpdateState).toBeUndefined();
  });

  test('aborts clarification update if the payment was concurrently cancelled or refunded', async () => {
    const payToUpdate = {
      _id: 'old-tx',
      inUpdateState: 'outCurrency',
      inAmountMessage: 50,
      inCurrency: 'ADM',
      save: jest.fn(),
      update: jest.fn(),
    };
    db.paymentsDb.findOne = jest.fn().mockResolvedValue({
      _id: 'old-tx',
      needToSendBack: true,
      inUpdateState: undefined,
    });

    const itx = incomingTx('BTC');
    await exchangeTxs(itx, admTx(), payToUpdate);

    expect(payToUpdate.save).not.toHaveBeenCalled();
    expect(itx.update).toHaveBeenCalledWith({ isProcessed: true }, true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('concurrently cancelled or refunded'));
  });
});

describe('exchangeTxs — rejections', () => {
  test('refuses a request it cannot parse at all', async () => {
    await exchangeTxs(incomingTx('just chatting'), admTx());

    expect(created[0]).toMatchObject({ isFinished: true, error: 8 });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('malformed'), 'error');
  });

  test('refuses a transfer hash it has already processed', async () => {
    depositClaims.registerClaim.mockResolvedValue({ isLate: true });

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created[0]).toMatchObject({ isFinished: true, error: 1 });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('duplicate'), 'error');
  });

  test('never re-creates a payment that already exists for the same ADAMANT transaction', async () => {
    // Saving a fresh document over the stored one would reset its validation and
    // payout state, and message the user a second time.
    db.paymentsDb.findOne.mockImplementation(async (query) =>
      query._id === 'adm-tx-1' ? { _id: 'adm-tx-1', transactionIsValid: true } : null,
    );

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created).toHaveLength(0);
    expect(depositClaims.registerClaim).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('already exists'));
  });

  test('refuses an amount that is not a positive number', async () => {
    const message = '{"type":"eth_transaction","amount":"-1","hash":"0xabc","comments":"ADM"}';

    await exchangeTxs(incomingTx(message), admTx());

    expect(created[0]).toMatchObject({ isFinished: true, error: 7 });
  });

  test('escalates an unknown incoming coin instead of trying to refund it', async () => {
    exchangerUtils.isKnown.mockImplementation((coin) => coin !== 'XYZ');

    const message = '{"type":"xyz_transaction","amount":"1","hash":"0xabc","comments":"ADM"}';

    await exchangeTxs(incomingTx(message), admTx());

    expect(created[0]).toMatchObject({ isFinished: true, needHumanCheck: true, error: 2 });
  });

  test('refunds a known but unaccepted incoming coin', async () => {
    exchangerUtils.isAccepted.mockReturnValue(false);

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created[0]).toMatchObject({ needToSendBack: true, isBasicChecksPassed: true, error: 5 });
  });

  test('refunds an incoming coin with no rates', async () => {
    exchangerUtils.hasTicker.mockImplementation((coin) => coin !== 'ADM');

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created[0]).toMatchObject({ needToSendBack: true, error: 32 });
  });

  test('escalates an ERC-20 token with no rates, because it cannot price the refund', async () => {
    exchangerUtils.hasTicker.mockReturnValue(false);
    exchangerUtils.isERC20.mockReturnValue(true);

    const message = '{"type":"usdt_transaction","amount":"100","hash":"0xabc","comments":"ADM"}';

    await exchangeTxs(incomingTx(message), admTx());

    expect(created[0]).toMatchObject({ needHumanCheck: true, isFinished: true, error: 32 });
  });

  test('refunds a transfer below the minimum value', async () => {
    exchangerUtils.convertCryptos.mockReturnValue({ outAmount: 0.5, exchangePrice: 1 });

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created[0]).toMatchObject({ needToSendBack: true, error: 20 });
  });

  test('refunds when buying the incoming coin above the configured maximum price', async () => {
    config.max_buy_price_usd_ADM = 0.005;
    exchangerUtils.getRate.mockReturnValue(0.01);

    try {
      await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

      expect(created[0]).toMatchObject({ needToSendBack: true, error: 101 });
    } finally {
      config.max_buy_price_usd_ADM = 0;
    }
  });

  test('refunds when selling the outgoing coin below the configured minimum price', async () => {
    config.min_sell_price_usd_BTC = 100000;
    exchangerUtils.getRate.mockReturnValue(80000);

    try {
      await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

      expect(created[0]).toMatchObject({ needToSendBack: true, error: 102 });
    } finally {
      config.min_sell_price_usd_BTC = 0;
    }
  });

  test('refunds when the user is over their daily limit', async () => {
    config.daily_limit_usd_BTC = 100;
    exchangerUtils.userDailyValue.mockResolvedValue(99);

    try {
      await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

      expect(created[0]).toMatchObject({ needToSendBack: true, error: 23 });
    } finally {
      config.daily_limit_usd_BTC = 0;
    }
  });

  test('checks the daily limit without counting the payment being checked', async () => {
    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(exchangerUtils.userDailyValue).toHaveBeenCalledWith(USER, 'adm-tx-1');
  });

  test('serializes one user’s requests, so two concurrent transfers cannot both fit under the daily limit', async () => {
    config.daily_limit_usd_BTC = 100;

    const saved = [];

    db.paymentsDb = jest.fn().mockImplementation(function (data) {
      Object.assign(this, data);
      this.save = jest.fn().mockImplementation(async () => {
        saved.push(this);

        return this._id;
      });
      this.update = jest.fn().mockImplementation(async (fields) => Object.assign(this, fields));
      created.push(this);
    });
    db.paymentsDb.findOne = jest.fn().mockResolvedValue(null);

    let readers = 0;
    let bothReading;
    const bothAreReading = new Promise((resolve) => {
      bothReading = resolve;
    });

    // The volume comes from what is stored. Without serialization both requests reach
    // this read before either has stored its payment, and both see the same old total.
    exchangerUtils.userDailyValue.mockImplementation(async (senderId, excludeId) => {
      readers += 1;

      if (readers >= 2) {
        bothReading();
      }

      await Promise.race([bothAreReading, new Promise((resolve) => setTimeout(resolve, 50))]);

      return saved
        .filter((payment) => payment.senderId === senderId && payment._id !== excludeId && !payment.needToSendBack)
        .reduce((total, payment) => total + payment.inAmountMessageUsd, 0);
    });

    try {
      // 60 USD each: either fits alone, both together exceed the 100 USD limit.
      await Promise.all([
        exchangeTxs(incomingTx('BTC'), admTx({ id: 'adm-tx-a', amount: 60 * SAT })),
        exchangeTxs(incomingTx('BTC'), admTx({ id: 'adm-tx-b', amount: 60 * SAT })),
      ]);

      const [first, second] = created;

      expect(first.error).toBeUndefined();
      expect(first.isBasicChecksPassed).toBe(true);
      expect(second).toMatchObject({ needToSendBack: true, error: 23 });
    } finally {
      config.daily_limit_usd_BTC = 0;
    }
  });

  test('applies no daily limit when the configured limit is zero', async () => {
    exchangerUtils.userDailyValue.mockResolvedValue(1000000);

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created[0].error).toBeUndefined();
    expect(created[0].isBasicChecksPassed).toBe(true);
  });

  test('refunds a transfer that does not cover the outgoing network fee', async () => {
    exchangerUtils.convertCryptos.mockImplementation((from, to, amount, considerFee) => ({
      outAmount: considerFee ? -0.00001 : Number(amount),
      exchangePrice: 1,
    }));

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created[0]).toMatchObject({ needToSendBack: true, error: 8 });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('doesn’t cover the network Tx fee'), 'warn');
  });

  test('refunds a payout that would be below the coin’s minimum transfer', async () => {
    exchangerUtils.isLowerThanMinBalance.mockReturnValue(true);

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created[0]).toMatchObject({ needToSendBack: true, error: 27 });
  });

  test('refunds when the outgoing amount cannot be calculated', async () => {
    exchangerUtils.convertCryptos.mockImplementation((from, to, amount, considerFee) => ({
      outAmount: considerFee ? NaN : Number(amount),
      exchangePrice: NaN,
    }));

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created[0]).toMatchObject({ needToSendBack: true, error: 7 });
  });
});

describe('exchangeTxs — asking the user to clarify', () => {
  test('asks which coin the user wants when the comment names an unknown one', async () => {
    exchangerUtils.isKnown.mockImplementation((coin) => coin !== 'XYZ');

    await exchangeTxs(incomingTx('XYZ'), admTx({ amount: 100 * SAT }));

    expect(created[0].inUpdateState).toBe('outCurrency');
    expect(created[0].needToSendBack).toBe(false);
    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('BTC, ETH or ADM'));
  });

  test('asks which coin the user wants when the comment is empty', async () => {
    await exchangeTxs(incomingTx(''), admTx({ amount: 100 * SAT }));

    expect(created[0].inUpdateState).toBe('outCurrency');
    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('Tell me which coin'));
  });

  test('asks again when the user asks to exchange a coin for itself', async () => {
    await exchangeTxs(incomingTx('ADM'), admTx({ amount: 100 * SAT }));

    expect(created[0].inUpdateState).toBe('outCurrency');
    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('by mistake'));
  });

  test('asks again when the bot does not pay out in the requested coin', async () => {
    exchangerUtils.isExchanged.mockReturnValue(false);

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));

    expect(created[0].inUpdateState).toBe('outCurrency');
    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('don’t exchange to'));
  });
});

describe('exchangeTxs — an accepted request', () => {
  test('records the quote and tells the user what to expect', async () => {
    exchangerUtils.convertCryptos.mockImplementation((from, to, amount, considerFee) =>
      considerFee ? { outAmount: 0.001, exchangePrice: 0.00001 } : { outAmount: 100, exchangePrice: 1 },
    );

    const itx = incomingTx('BTC');

    await exchangeTxs(itx, admTx({ amount: 100 * SAT }));

    expect(created[0]).toMatchObject({ isBasicChecksPassed: true, outAmount: 0.001, exchangePrice: 0.00001 });
    expect(created[0].needToSendBack).toBe(false);
    expect(created[0].isFinished).toBe(false);
    expect(itx.update).toHaveBeenCalledWith({ isProcessed: true }, true);
    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('I’ve got your request'));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('incoming transaction to exchange'), 'log');
  });

  test('promises confirmations for a slow coin and not for an instant one', async () => {
    // Keep the USD value above the minimum while the payout stays small.
    exchangerUtils.convertCryptos.mockImplementation((from, to) =>
      to === 'USD' ? { outAmount: 100, exchangePrice: 1 } : { outAmount: 0.001, exchangePrice: 0.00001 },
    );

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));
    expect(messenger.sendMessage).toHaveBeenLastCalledWith(USER, expect.stringContaining('block confirmations'));

    exchangerUtils.isFastPayments.mockReturnValue(true);

    await exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }));
    expect(messenger.sendMessage).toHaveBeenLastCalledWith(USER, expect.not.stringContaining('block confirmations'));
  });
});

describe('exchangeTxs — failures', () => {
  test('notifies the operator instead of throwing when processing fails', async () => {
    depositClaims.registerClaim.mockRejectedValue(new Error('db down'));

    await expect(exchangeTxs(incomingTx('BTC'), admTx({ amount: 100 * SAT }))).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Error while processing the exchange Tx'), 'error');
  });
});
