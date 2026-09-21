jest.mock('../../modules/DB', () => ({ paymentsDb: { find: jest.fn() } }));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../helpers/messenger', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
  sendTransferMessage: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../helpers/cryptos/exchanger', () => ({
  isERC20: jest.fn().mockReturnValue(false),
  isEthOrERC20: jest.fn().mockReturnValue(false),
  ADM: { getTransaction: jest.fn(), getLastBlockHeight: jest.fn(), balance: 1000 },
  BTC: { getTransaction: jest.fn(), getLastBlockHeight: jest.fn(), balance: 1 },
  USDT: { getTransaction: jest.fn(), getLastBlockHeight: jest.fn(), balance: 100 },
  ETH: { balance: 1 },
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
const sentTxChecker = require('../../modules/sentTxChecker');
const { createPayment } = require('../fixtures/payment');

beforeEach(() => {
  exchangerUtils.isERC20.mockReturnValue(false);
  exchangerUtils.isEthOrERC20.mockReturnValue(false);
  // `clearMocks` resets call history but not implementations, so re-arm the ones
  // individual tests override.
  messenger.sendMessage.mockResolvedValue(true);
  messenger.sendTransferMessage.mockResolvedValue(true);
});

describe('sentTxChecker.check — exchange payouts', () => {
  test('closes the deal and sends a transfer card once the payout is confirmed', async () => {
    exchangerUtils.BTC.getTransaction.mockResolvedValue({ status: true, confirmations: 1, height: 10 });

    const pay = createPayment({ outTxid: 'out-tx-1', outCurrency: 'BTC', outAmount: 0.001 });

    await sentTxChecker.check(pay);

    expect(pay.isFinished).toBe(true);
    expect(messenger.sendTransferMessage).toHaveBeenCalledWith(
      pay.senderId,
      'BTC',
      0.001,
      'out-tx-1',
      expect.stringContaining('Thank you'),
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('successfully exchanged'), 'info');
  });

  test('does not send a separate message for an ADM payout, which carries its own', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue({ status: true, confirmations: 1, height: 10 });

    const pay = createPayment({ outTxid: 'out-tx-1', outCurrency: 'ADM', outAmount: 100 });

    await sentTxChecker.check(pay);

    expect(pay.isFinished).toBe(true);
    expect(messenger.sendTransferMessage).not.toHaveBeenCalled();
  });

  test('quarantines a sent transfer whose coin adapter no longer exists', async () => {
    const pay = createPayment({ outTxid: 'out-tx-1', outCurrency: 'LSK' });

    await sentTxChecker.check(pay);

    expect(pay.needHumanCheck).toBe(true);
    expect(pay.isFinished).toBe(true);
    expect(pay.errorCheckOuterTX).toBe(constants.ERRORS.UNSUPPORTED_COIN);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Automatic retries were disabled'), 'error');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Unsupported legacy coin 'LSK'"));
  });

  test('keeps the deal open when the transfer card cannot be delivered', async () => {
    exchangerUtils.BTC.getTransaction.mockResolvedValue({ status: true, confirmations: 1, height: 10 });
    messenger.sendTransferMessage.mockResolvedValue(false);

    const pay = createPayment({ outTxid: 'out-tx-1', outCurrency: 'BTC' });

    await sentTxChecker.check(pay);

    expect(pay.isFinished).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to send the ADM message'));
  });

  test('derives the confirmations from the chain tip when the node reports only a height', async () => {
    exchangerUtils.BTC.getTransaction.mockResolvedValue({ status: undefined, confirmations: undefined, height: 100 });
    exchangerUtils.BTC.getLastBlockHeight.mockResolvedValue(100);

    const pay = createPayment({ outTxid: 'out-tx-1', outCurrency: 'BTC' });

    await sentTxChecker.check(pay);

    expect(pay.outConfirmations).toBe(1);
    expect(pay.isFinished).toBe(true);
  });

  test('keeps waiting while the payout has no confirmations at all', async () => {
    exchangerUtils.BTC.getTransaction.mockResolvedValue({ status: undefined, confirmations: 0, height: undefined });

    const pay = createPayment({ outTxid: 'out-tx-1', outCurrency: 'BTC' });

    await sentTxChecker.check(pay);

    expect(pay.isFinished).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to get the height or confirmations'));
  });

  test('accepts an InstantSend payout without waiting for confirmations', async () => {
    exchangerUtils.BTC.getTransaction.mockResolvedValue({
      status: undefined,
      confirmations: 0,
      height: undefined,
      instantlock: true,
      instantlock_internal: true,
    });

    const pay = createPayment({ outTxid: 'out-tx-1', outCurrency: 'BTC' });

    await sentTxChecker.check(pay);

    expect(pay.outTxIsInstant).toBe(true);
    expect(pay.isFinished).toBe(true);
  });
});

describe('sentTxChecker.check — a payout that is missing', () => {
  test('retries while the payout is too new to be visible', async () => {
    exchangerUtils.BTC.getTransaction.mockResolvedValue(undefined);

    const pay = createPayment({ outTxid: 'out-tx-1', outCurrency: 'BTC', tryCounterCheckOutTX: 3 });

    await sentTxChecker.check(pay);

    expect(pay.tryCounterCheckOutTX).toBe(4);
    expect(pay.needHumanCheck).toBe(false);
    expect(pay.save).toHaveBeenCalled();
  });

  test('escalates once the retries are exhausted', async () => {
    exchangerUtils.BTC.getTransaction.mockResolvedValue(undefined);

    const pay = createPayment({
      outTxid: 'out-tx-1',
      outCurrency: 'BTC',
      tryCounterCheckOutTX: constants.SENDER_GET_TX_RETRIES,
    });

    await sentTxChecker.check(pay);

    expect(pay.needHumanCheck).toBe(true);
    expect(pay.isFinished).toBe(true);
    expect(pay.errorCheckOuterTX).toBe(constants.ERRORS.UNABLE_TO_FETCH_SENT_TX);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('unable to verify the exchange transfer'), 'error');
  });
});

describe('sentTxChecker.check — a payout that failed', () => {
  test('clears the hash so a UTXO payout is retried', async () => {
    exchangerUtils.BTC.getTransaction.mockResolvedValue({ status: false });

    const pay = createPayment({ outTxid: 'out-tx-1', outCurrency: 'BTC' });

    await sentTxChecker.check(pay);

    expect(pay.outTxid).toBeNull();
    expect(pay.outTxFailedCounter).toBe(1);
    expect(pay.needHumanCheck).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('**failed**'), 'error');
  });

  test('clears the hash so a failed refund is retried', async () => {
    exchangerUtils.BTC.getTransaction.mockResolvedValue({ status: false });

    const pay = createPayment({ outTxid: null, sentBackTx: 'back-tx-1', inCurrency: 'BTC', sentBackAmount: 0.001 });

    await sentTxChecker.check(pay);

    expect(pay.sentBackTx).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('the refund of'), 'error');
  });

  test('stops retrying an Ethereum payout once its limited retries are used up', async () => {
    exchangerUtils.isEthOrERC20.mockReturnValue(true);
    exchangerUtils.USDT.getTransaction.mockResolvedValue({ status: false });

    const pay = createPayment({
      outTxid: 'out-tx-1',
      outCurrency: 'USDT',
      outTxFailedCounter: constants.SENDER_RESEND_ETH_RETRIES,
    });

    await sentTxChecker.check(pay);

    expect(pay.needHumanCheck).toBe(true);
    expect(pay.isFinished).toBe(true);
    expect(pay.outTxid).toBe('out-tx-1');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('No retries left'), 'error');
    expect(messenger.sendMessage).toHaveBeenCalledWith(pay.senderId, expect.stringContaining('attempts failed'));
  });
});

describe('sentTxChecker.check — refunds', () => {
  test('closes the deal and sends a transfer card once the refund is confirmed', async () => {
    exchangerUtils.BTC.getTransaction.mockResolvedValue({ status: true, confirmations: 1, height: 10 });

    const pay = createPayment({ outTxid: null, sentBackTx: 'back-tx-1', inCurrency: 'BTC', sentBackAmount: 0.0009 });

    await sentTxChecker.check(pay);

    expect(pay.isFinished).toBe(true);
    expect(messenger.sendTransferMessage).toHaveBeenCalledWith(
      pay.senderId,
      'BTC',
      0.0009,
      'back-tx-1',
      expect.stringContaining('refund'),
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('successfully sent back'), 'log');
  });
});

describe('sentTxChecker.run', () => {
  test('only considers open deals that have an outgoing transfer', async () => {
    db.paymentsDb.find.mockResolvedValue([]);

    await sentTxChecker.run();

    expect(db.paymentsDb.find).toHaveBeenCalledWith({
      $and: [{ isFinished: false }, { $or: [{ outTxid: { $ne: null } }, { sentBackTx: { $ne: null } }] }],
    });
  });

  test('keeps processing the queue when one payment throws', async () => {
    exchangerUtils.BTC.getTransaction.mockRejectedValueOnce(new Error('node exploded')).mockResolvedValue({
      status: true,
      confirmations: 1,
      height: 10,
    });

    const failing = createPayment({ _id: 'a', outTxid: 'out-a', outCurrency: 'BTC' });
    const healthy = createPayment({ _id: 'b', outTxid: 'out-b', outCurrency: 'BTC' });

    db.paymentsDb.find.mockResolvedValue([failing, healthy]);

    await sentTxChecker.run();

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to check the sent exchange Tx'));
    expect(healthy.isFinished).toBe(true);
  });
});
