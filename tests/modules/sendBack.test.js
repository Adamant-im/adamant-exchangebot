jest.mock('../../modules/DB', () => ({ paymentsDb: { find: jest.fn() } }));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../helpers/messenger', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
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

  test('deducts the refund from the cached balance', async () => {
    const pay = refundablePayment();

    await sendBack.refund(pay);

    expect(exchangerUtils.ADM.balance).toBe(1000 - 99.5);
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
