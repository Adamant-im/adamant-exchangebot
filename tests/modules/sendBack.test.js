jest.mock('../../modules/DB', () => ({ paymentsDb: { find: jest.fn() } }));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../helpers/messenger', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../modules/depositClaims', () => ({
  AUTHORIZATION_STATUS: {
    AUTHORIZED: 'authorized',
    ALREADY_AUTHORIZED: 'already-authorized',
    WAIT: 'wait',
    MANUAL: 'manual',
    CLAIMED: 'claimed',
  },
  authorizePayout: jest.fn().mockResolvedValue({ status: 'authorized' }),
  reportWait: jest.fn(),
  clearWait: jest.fn(),
}));
jest.mock('../../helpers/cryptos/exchanger', () => ({
  isERC20: jest.fn().mockReturnValue(false),
  convertCryptos: jest.fn(),
  ADM: { getBalance: jest.fn(), FEE: 0.5, balance: 1000, send: jest.fn() },
  USDT: { getBalance: jest.fn(), FEE: 0.005, balance: 1000, send: jest.fn() },
  ETH: { getBalance: jest.fn(), FEE: 0.005, balance: 1 },
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
const constants = require('../../helpers/const');
const sendBack = require('../../modules/sendBack');
const depositClaims = require('../../modules/depositClaims');
const { createPayment } = require('../fixtures/payment');

/**
 * Builds a payment that is waiting to be refunded.
 *
 * @param {object} [overrides] Fields to set on the payment
 * @returns {object}
 */
function refundablePayment(overrides = {}) {
  return createPayment({ needToSendBack: true, inCurrency: 'ADM', inAmountReal: 100, ...overrides });
}

beforeEach(() => {
  exchangerUtils.isERC20.mockReturnValue(false);
  exchangerUtils.convertCryptos.mockReturnValue({ outAmount: 1, exchangePrice: 1 });
  exchangerUtils.ADM.getBalance.mockResolvedValue(1000);
  exchangerUtils.ADM.balance = 1000;
  exchangerUtils.ADM.send.mockResolvedValue({ success: true, hash: 'back-tx-1' });
  exchangerUtils.USDT.getBalance.mockResolvedValue(1000);
  exchangerUtils.USDT.balance = 1000;
  exchangerUtils.USDT.send.mockResolvedValue({ success: true, hash: 'back-tx-2' });
  exchangerUtils.ETH.getBalance.mockResolvedValue(1);
  exchangerUtils.ETH.balance = 1;
});

describe('sendBack.refund', () => {
  test('sends the incoming amount minus the network fee, back to the sender’s own address', async () => {
    const pay = refundablePayment();

    await sendBack.refund(pay);

    expect(pay.sentBackAmount).toBe(99.5);
    expect(exchangerUtils.ADM.send).toHaveBeenCalledWith(
      expect.objectContaining({ address: pay.senderKvsInAddress, value: 99.5 }),
    );
    expect(pay.sentBackTx).toBe('back-tx-1');
  });

  test('marks the refund as in flight before broadcasting, and clears it afterwards', async () => {
    const pay = refundablePayment();
    const seenDuringSend = [];

    exchangerUtils.ADM.send.mockImplementation(async () => {
      seenDuringSend.push(pay.sendBackStartedAt);

      return { success: true, hash: 'back-tx-1' };
    });

    await sendBack.refund(pay);

    expect(seenDuringSend[0]).toEqual(expect.any(Number));
    expect(pay.sendBackStartedAt).toBeNull();
  });

  test('deducts the refund and its network fee from the cached balance', async () => {
    const pay = refundablePayment();

    await sendBack.refund(pay);

    // 99.5 ADM refunded plus the 0.5 ADM fee the bot's wallet pays for sending it.
    expect(exchangerUtils.ADM.balance).toBe(1000 - 99.5 - 0.5);
  });

  test('deducts an ERC-20 refund’s fee from Ether, and converts it into the token', async () => {
    exchangerUtils.isERC20.mockReturnValue(true);
    // 0.005 ETH is worth 12 USDT.
    exchangerUtils.convertCryptos.mockReturnValue({ outAmount: 12, exchangePrice: 2400 });

    const pay = refundablePayment({ inCurrency: 'USDT', inAmountReal: 100 });

    await sendBack.refund(pay);

    expect(pay.sentBackAmount).toBe(88);
    expect(exchangerUtils.USDT.balance).toBe(1000 - 88);
    expect(exchangerUtils.ETH.balance).toBeCloseTo(1 - 0.005, 8);
  });

  test('keeps a token refund queued while there is no ETH rate to price its fee', async () => {
    // Without the rate the refund amount is NaN, which must not read as "does not
    // cover the fee": that would finish the payment and keep the user's deposit.
    exchangerUtils.isERC20.mockReturnValue(true);
    exchangerUtils.convertCryptos.mockReturnValue({ outAmount: NaN, exchangePrice: NaN });

    const pay = refundablePayment({ inCurrency: 'USDT', inAmountReal: 100 });

    await sendBack.refund(pay);

    expect(exchangerUtils.USDT.send).not.toHaveBeenCalled();
    expect(pay.isFinished).toBe(false);
    expect(pay.errorSendBack).toBeUndefined();
    expect(pay.save).not.toHaveBeenCalled();
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    // It can go on indefinitely if the InfoService stops quoting the token, so the
    // operator is reminded while it lasts.
    expect(depositClaims.reportWait).toHaveBeenCalledWith(pay, expect.stringContaining('no ETH/USDT rate'), 'refund', {
      remindEvery: constants.WAIT_REMINDER_INTERVAL,
    });
  });

  test('keeps a refund queued while the network fee is not known yet', async () => {
    // For Ethereum, a zero fee means the gas price has not been read yet.
    exchangerUtils.ADM.FEE = 0;

    try {
      const pay = refundablePayment();

      await sendBack.refund(pay);

      expect(exchangerUtils.ADM.send).not.toHaveBeenCalled();
      expect(pay.isFinished).toBe(false);
      expect(pay.save).not.toHaveBeenCalled();
      expect(depositClaims.reportWait).toHaveBeenCalledWith(
        pay,
        expect.stringContaining('fee is not known'),
        'refund',
        {
          remindEvery: constants.WAIT_REMINDER_INTERVAL,
        },
      );
    } finally {
      exchangerUtils.ADM.FEE = 0.5;
    }
  });

  test('keeps a wait open across ticks, and ends it on the first tick that goes ahead', async () => {
    // The record is what keeps a long wait from being logged on every tick, and what
    // the reminders are counted from, so only a tick that did not wait may clear it.
    exchangerUtils.isERC20.mockReturnValue(true);
    exchangerUtils.convertCryptos.mockReturnValue({ outAmount: NaN, exchangePrice: NaN });

    const pay = refundablePayment({ inCurrency: 'USDT', inAmountReal: 100 });

    await sendBack.refund(pay);
    await sendBack.refund(pay);

    expect(depositClaims.reportWait).toHaveBeenCalledTimes(2);
    expect(depositClaims.clearWait).not.toHaveBeenCalled();

    // The rate is back.
    exchangerUtils.convertCryptos.mockReturnValue({ outAmount: 12, exchangePrice: 2400 });

    await sendBack.refund(pay);

    expect(exchangerUtils.USDT.send).toHaveBeenCalled();
    expect(depositClaims.clearWait).toHaveBeenCalledTimes(1);
    expect(depositClaims.clearWait).toHaveBeenCalledWith(pay);
  });

  test('ends any wait when a tick fails with an error', async () => {
    exchangerUtils.ADM.getBalance.mockRejectedValue(new Error('node down'));

    const pay = refundablePayment();

    await expect(sendBack.refund(pay)).rejects.toThrow('node down');
    expect(depositClaims.clearWait).toHaveBeenCalledWith(pay);
  });

  test('refuses to refund an amount that does not cover the fee', async () => {
    const pay = refundablePayment({ inAmountReal: 0.4 });

    await sendBack.refund(pay);

    expect(exchangerUtils.ADM.send).not.toHaveBeenCalled();
    expect(pay.errorSendBack).toBe(17);
    expect(pay.isFinished).toBe(true);
    expect(messenger.sendMessage).toHaveBeenCalledWith(pay.senderId, expect.stringContaining('does not cover'));
  });

  test('refuses to refund exactly the fee, which would leave nothing to send', async () => {
    const pay = refundablePayment({ inAmountReal: 0.5 });

    await sendBack.refund(pay);

    expect(exchangerUtils.ADM.send).not.toHaveBeenCalled();
    expect(pay.errorSendBack).toBe(17);
  });

  test('escalates when the balance cannot cover the refund plus its fee', async () => {
    // 99.5 to send plus a 0.5 fee needs 100; the bot holds 99.9.
    exchangerUtils.ADM.getBalance.mockResolvedValue(99.9);

    const pay = refundablePayment();

    await sendBack.refund(pay);

    expect(exchangerUtils.ADM.send).not.toHaveBeenCalled();
    expect(pay.errorSendBack).toBe(18);
    expect(pay.needHumanCheck).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('insufficient balance'), 'error');
  });

  test('waits for the next tick when the balance cannot be read at all', async () => {
    exchangerUtils.ADM.getBalance.mockResolvedValue(undefined);

    const pay = refundablePayment();

    await sendBack.refund(pay);

    expect(exchangerUtils.ADM.send).not.toHaveBeenCalled();
    expect(pay.errorSendBack).toBeUndefined();
    expect(pay.needHumanCheck).toBe(false);
  });

  test('quarantines a refund whose coin adapter no longer exists', async () => {
    const pay = refundablePayment({ inCurrency: 'LSK' });

    await sendBack.refund(pay);

    expect(pay.needHumanCheck).toBe(true);
    expect(pay.isFinished).toBe(true);
    expect(pay.errorSendBack).toBe(constants.ERRORS.UNSUPPORTED_COIN);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('no longer supported by this bot'), 'error');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Unsupported legacy coin 'LSK'"));
  });

  test('retries a failed refund', async () => {
    exchangerUtils.ADM.send.mockResolvedValue({ success: false, error: 'node down' });

    const pay = refundablePayment();

    await sendBack.refund(pay);

    expect(pay.counterSendBack).toBe(1);
    expect(pay.needHumanCheck).toBe(false);
    expect(pay.sendBackStartedAt).toBeNull();
  });

  test('escalates once the refund retries are exhausted', async () => {
    exchangerUtils.ADM.send.mockResolvedValue({ success: false, error: 'node down' });

    const pay = refundablePayment({ counterSendBack: constants.SENDBACK_RETRIES - 1 });

    await sendBack.refund(pay);

    expect(pay.errorSendBack).toBe(19);
    expect(pay.needHumanCheck).toBe(true);
    expect(pay.isFinished).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('cannot make the transaction'), 'error');
  });
});

describe('sendBack.run', () => {
  test('only considers payments marked for a refund that have not been refunded', async () => {
    db.paymentsDb.find.mockResolvedValue([]);

    await sendBack.run();

    expect(db.paymentsDb.find).toHaveBeenLastCalledWith(
      expect.objectContaining({
        needToSendBack: true,
        sentBackTx: null,
        outTxid: null,
        needHumanCheck: false,
        // A refund whose broadcast outcome was never recorded must never be re-selected.
        sendBackStartedAt: null,
      }),
    );
  });

  test('escalates leftover in-flight refunds before selecting anything to send', async () => {
    const stuck = refundablePayment({ sendBackStartedAt: 1700000000000 });

    db.paymentsDb.find.mockResolvedValueOnce([stuck]).mockResolvedValue([]);

    await sendBack.run();

    expect(stuck.needHumanCheck).toBe(true);
    expect(exchangerUtils.ADM.send).not.toHaveBeenCalled();
  });

  test('never retries a refund whose outcome is unknown, and leaves the marker for review', async () => {
    exchangerUtils.ADM.send.mockResolvedValue({
      success: false,
      isAmbiguous: true,
      error: 'the node did not answer',
    });

    const pay = refundablePayment();

    await sendBack.refund(pay);

    expect(pay.sendBackStartedAt).toEqual(expect.any(Number));
    expect(pay.needHumanCheck).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Unable to confirm the outcome'));
  });

  test('tracks an ambiguous refund by hash when the built transaction id is known', async () => {
    exchangerUtils.ADM.send.mockResolvedValue({
      success: false,
      isAmbiguous: true,
      hash: 'known-back-txid',
      error: 'the node did not answer',
    });

    const pay = refundablePayment();

    await sendBack.refund(pay);

    expect(pay.sentBackTx).toBe('known-back-txid');
    expect(pay.sendBackStartedAt).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Tracking it instead of retrying'));
  });

  test('keeps processing the queue when one refund cannot be made right now', async () => {
    const blocked = refundablePayment({ _id: 'a' });
    const healthy = refundablePayment({ _id: 'b' });

    exchangerUtils.ADM.getBalance.mockResolvedValueOnce(undefined).mockResolvedValue(1000);
    db.paymentsDb.find.mockResolvedValueOnce([]).mockResolvedValue([blocked, healthy]);

    await sendBack.run();

    expect(blocked.sentBackTx).toBeNull();
    expect(healthy.sentBackTx).toBe('back-tx-1');
  });
});

describe('sendBack.reconcileInterrupted', () => {
  test('escalates a refund that was in flight when the bot stopped', async () => {
    const pay = refundablePayment({ sendBackStartedAt: 1700000000000 });

    db.paymentsDb.find.mockResolvedValue([pay]);

    await sendBack.reconcileInterrupted();

    expect(pay.needHumanCheck).toBe(true);
    expect(pay.sendBackStartedAt).toBeNull();
    expect(exchangerUtils.ADM.send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('interrupted while sending back'), 'error');
  });
});

describe('sendBack — paused and deferred sends', () => {
  afterEach(() => {
    delete exchangerUtils.ADM.getSendBlocker;
  });

  test('skips a refund while the coin’s sends are paused, without spending an attempt', async () => {
    exchangerUtils.ADM.getSendBlocker = jest.fn().mockResolvedValue('paused');

    const pay = refundablePayment({ counterSendBack: 2 });

    await sendBack.refund(pay);

    expect(exchangerUtils.ADM.send).not.toHaveBeenCalled();
    expect(pay.counterSendBack).toBe(2);
    expect(pay.sendBackStartedAt).toBeUndefined();
  });

  test('keeps a deferred refund queued: the attempt is not counted and the marker is cleared', async () => {
    exchangerUtils.ADM.send.mockResolvedValue({ success: false, isDeferred: true, error: 'paused' });

    const pay = refundablePayment({ counterSendBack: constants.SENDBACK_RETRIES - 1 });

    await sendBack.refund(pay);

    expect(pay.counterSendBack).toBe(constants.SENDBACK_RETRIES - 1);
    expect(pay.sendBackStartedAt).toBeNull();
    expect(pay.needHumanCheck).toBe(false);
    expect(depositClaims.reportWait).toHaveBeenCalledWith(pay, 'paused', 'refund', {});
  });
});
