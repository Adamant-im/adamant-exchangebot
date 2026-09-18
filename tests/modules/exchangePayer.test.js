jest.mock('../../modules/DB', () => ({ paymentsDb: { find: jest.fn() } }));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../helpers/messenger', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../helpers/cryptos/exchanger', () => ({
  isERC20: jest.fn().mockReturnValue(false),
  BTC: { getBalance: jest.fn(), FEE: 0.0001, balance: 1, send: jest.fn() },
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
const exchangePayer = require('../../modules/exchangePayer');
const { createPayment } = require('../fixtures/payment');

beforeEach(() => {
  exchangerUtils.isERC20.mockReturnValue(false);
  exchangerUtils.BTC.getBalance.mockResolvedValue(1);
  exchangerUtils.BTC.balance = 1;
  exchangerUtils.BTC.send.mockResolvedValue({ success: true, hash: 'out-tx-1' });
  exchangerUtils.ETH.getBalance.mockResolvedValue(1);
  exchangerUtils.ETH.balance = 1;
  exchangerUtils.USDT.getBalance.mockResolvedValue(1000);
  exchangerUtils.USDT.balance = 1000;
  exchangerUtils.USDT.send.mockResolvedValue({ success: true, hash: 'out-tx-2' });
});

describe('exchangePayer.payOut', () => {
  test('sends the payout to the address from the KVS and stores the hash', async () => {
    const pay = createPayment();

    await exchangePayer.payOut(pay);

    expect(exchangerUtils.BTC.send).toHaveBeenCalledWith(
      expect.objectContaining({ address: pay.senderKvsOutAddress, value: 0.001 }),
    );
    expect(pay.outTxid).toBe('out-tx-1');
  });

  test('marks the payout as in flight before broadcasting, and clears it afterwards', async () => {
    const pay = createPayment();
    const seenDuringSend = [];

    exchangerUtils.BTC.send.mockImplementation(async () => {
      seenDuringSend.push(pay.payoutStartedAt);

      return { success: true, hash: 'out-tx-1' };
    });

    await exchangePayer.payOut(pay);

    expect(seenDuringSend[0]).toEqual(expect.any(Number));
    expect(pay.payoutStartedAt).toBeNull();
  });

  test('deducts the amount and the fee from the cached balance', async () => {
    const pay = createPayment();

    await exchangePayer.payOut(pay);

    expect(exchangerUtils.BTC.balance).toBeCloseTo(1 - 0.001 - 0.0001, 8);
  });

  test('deducts an ERC-20 payout from the token, and its fee from Ether', async () => {
    exchangerUtils.isERC20.mockReturnValue(true);

    const pay = createPayment({ outCurrency: 'USDT', outAmount: 100 });

    await exchangePayer.payOut(pay);

    expect(exchangerUtils.USDT.balance).toBe(900);
    expect(exchangerUtils.ETH.balance).toBeCloseTo(1 - 0.005, 8);
  });

  test('refunds instead of paying out when the balance is too low', async () => {
    exchangerUtils.BTC.getBalance.mockResolvedValue(0.0005);

    const pay = createPayment();

    await exchangePayer.payOut(pay);

    expect(exchangerUtils.BTC.send).not.toHaveBeenCalled();
    expect(pay.needToSendBack).toBe(true);
    expect(pay.error).toBe(15);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('insufficient balance'), 'warn');
    expect(messenger.sendMessage).toHaveBeenCalledWith(pay.senderId, expect.stringContaining('insufficient funds'));
  });

  test('counts the network fee when checking the balance', async () => {
    // Exactly the payout amount, with nothing left for the fee.
    exchangerUtils.BTC.getBalance.mockResolvedValue(0.001);

    const pay = createPayment();

    await exchangePayer.payOut(pay);

    expect(exchangerUtils.BTC.send).not.toHaveBeenCalled();
    expect(pay.needToSendBack).toBe(true);
  });

  test('requires Ether for the fee of an ERC-20 payout', async () => {
    exchangerUtils.isERC20.mockReturnValue(true);
    exchangerUtils.ETH.getBalance.mockResolvedValue(0);

    const pay = createPayment({ outCurrency: 'USDT', outAmount: 100 });

    await exchangePayer.payOut(pay);

    expect(exchangerUtils.USDT.send).not.toHaveBeenCalled();
    expect(pay.needToSendBack).toBe(true);
  });

  test('waits for the next tick when the balance cannot be read at all', async () => {
    exchangerUtils.BTC.getBalance.mockResolvedValue(undefined);

    const pay = createPayment();

    await exchangePayer.payOut(pay);

    expect(exchangerUtils.BTC.send).not.toHaveBeenCalled();
    expect(pay.needToSendBack).toBe(false);
    expect(pay.error).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to update the BTC balance'));
  });

  test('quarantines a payout whose coin adapter no longer exists', async () => {
    const pay = createPayment({ outCurrency: 'LSK' });

    await exchangePayer.payOut(pay);

    expect(pay.needHumanCheck).toBe(true);
    expect(pay.isFinished).toBe(true);
    expect(pay.error).toBe(constants.ERRORS.UNSUPPORTED_COIN);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('no longer supported by this bot'), 'error');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Unsupported legacy coin 'LSK'"));
  });

  test('retries a failed payout without giving up', async () => {
    exchangerUtils.BTC.send.mockResolvedValue({ success: false, error: 'node down' });

    const pay = createPayment();

    await exchangePayer.payOut(pay);

    expect(pay.counterSendExchange).toBe(1);
    expect(pay.needToSendBack).toBe(false);
    expect(pay.payoutStartedAt).toBeNull();
    expect(pay.save).toHaveBeenCalled();
  });

  test('never retries a payout whose outcome is unknown, and leaves the marker for review', async () => {
    exchangerUtils.BTC.send.mockResolvedValue({
      success: false,
      isAmbiguous: true,
      error: 'the node did not answer',
    });

    const pay = createPayment();

    await exchangePayer.payOut(pay);

    // The marker stays set, so the next tick escalates instead of sending again.
    expect(pay.payoutStartedAt).toEqual(expect.any(Number));
    expect(pay.needToSendBack).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Unable to confirm the outcome'));
  });

  test('tracks an ambiguous payout by hash when the built transaction id is known', async () => {
    exchangerUtils.BTC.send.mockResolvedValue({
      success: false,
      isAmbiguous: true,
      hash: 'known-txid',
      error: 'the node did not answer',
    });

    const pay = createPayment();

    await exchangePayer.payOut(pay);

    expect(pay.outTxid).toBe('known-txid');
    expect(pay.payoutStartedAt).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Tracking it instead of retrying'));
  });

  test('gives up and refunds once the retries are exhausted', async () => {
    exchangerUtils.BTC.send.mockResolvedValue({ success: false, error: 'node down' });

    const pay = createPayment({ counterSendExchange: constants.EXCHANGER_RETRIES - 1 });

    await exchangePayer.payOut(pay);

    expect(pay.counterSendExchange).toBe(constants.EXCHANGER_RETRIES);
    expect(pay.needToSendBack).toBe(true);
    expect(pay.error).toBe(16);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('cannot make the transaction'), 'error');
  });
});

describe('exchangePayer.run', () => {
  test('only considers payments that are validated, confirmed and unpaid', async () => {
    db.paymentsDb.find.mockResolvedValue([]);

    await exchangePayer.run();

    expect(db.paymentsDb.find).toHaveBeenCalledWith({
      isBasicChecksPassed: true,
      transactionIsValid: true,
      inTxConfirmed: true,
      isFinished: false,
      transactionIsFailed: false,
      needToSendBack: false,
      needHumanCheck: false,
      outTxid: null,
      // A payment whose broadcast outcome was never recorded must never be re-selected.
      payoutStartedAt: null,
    });
  });

  test('escalates leftover in-flight payouts before selecting anything to send', async () => {
    const stuck = createPayment({ payoutStartedAt: 1700000000000 });

    db.paymentsDb.find.mockResolvedValueOnce([stuck]).mockResolvedValue([]);

    await exchangePayer.run();

    expect(stuck.needHumanCheck).toBe(true);
    expect(exchangerUtils.BTC.send).not.toHaveBeenCalled();
    // The reconciliation query runs first, then the payout selector.
    expect(db.paymentsDb.find.mock.calls[0][0]).toMatchObject({ payoutStartedAt: { $ne: null } });
    expect(db.paymentsDb.find.mock.calls[1][0]).toMatchObject({ payoutStartedAt: null });
  });

  test('keeps processing the queue when one payment throws', async () => {
    const failing = createPayment({ _id: 'a' });
    const healthy = createPayment({ _id: 'b' });

    failing.update.mockRejectedValueOnce(new Error('db down'));
    // Nothing is left in flight, so reconciliation finds nothing.
    db.paymentsDb.find.mockResolvedValueOnce([]).mockResolvedValue([failing, healthy]);

    await exchangePayer.run();

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Error while sending the exchange payment'));
    expect(healthy.outTxid).toBe('out-tx-1');
  });

  test('keeps processing the queue when one payment cannot be paid right now', async () => {
    const blocked = createPayment({ _id: 'a', outCurrency: 'BTC' });
    const healthy = createPayment({ _id: 'b', outCurrency: 'BTC' });

    exchangerUtils.BTC.getBalance.mockResolvedValueOnce(undefined).mockResolvedValue(1);
    db.paymentsDb.find.mockResolvedValueOnce([]).mockResolvedValue([blocked, healthy]);

    await exchangePayer.run();

    expect(blocked.outTxid).toBeNull();
    expect(healthy.outTxid).toBe('out-tx-1');
  });
});

describe('exchangePayer.reconcileInterrupted', () => {
  test('escalates a payout that was in flight when the bot stopped', async () => {
    const pay = createPayment({ payoutStartedAt: 1700000000000 });

    db.paymentsDb.find.mockResolvedValue([pay]);

    await exchangePayer.reconcileInterrupted();

    expect(pay.needHumanCheck).toBe(true);
    expect(pay.payoutStartedAt).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('interrupted while sending'), 'error');
  });

  test('never re-sends such a payout automatically', async () => {
    const pay = createPayment({ payoutStartedAt: 1700000000000 });

    db.paymentsDb.find.mockResolvedValue([pay]);

    await exchangePayer.reconcileInterrupted();

    expect(exchangerUtils.BTC.send).not.toHaveBeenCalled();
  });

  test('looks only at payments with no stored hash', async () => {
    db.paymentsDb.find.mockResolvedValue([]);

    await exchangePayer.reconcileInterrupted();

    expect(db.paymentsDb.find).toHaveBeenCalledWith({
      payoutStartedAt: { $ne: null },
      outTxid: null,
      isFinished: false,
    });
  });
});
