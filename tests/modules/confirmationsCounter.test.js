jest.mock('../../modules/DB', () => ({ paymentsDb: { find: jest.fn() } }));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../helpers/messenger', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../helpers/cryptos/exchanger', () => ({
  ADM: { getTransaction: jest.fn(), getLastBlockHeight: jest.fn() },
  DASH: { getTransaction: jest.fn(), getLastBlockHeight: jest.fn() },
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
const constants = require('../../helpers/const');
const counter = require('../../modules/confirmationsCounter');
const { createPayment } = require('../fixtures/payment');

describe('confirmationsCounter.count', () => {
  test('confirms a transfer that has reached the required confirmations', async () => {
    // The fixture config requires one confirmation for ADM.
    exchangerUtils.ADM.getTransaction.mockResolvedValue({ status: true, confirmations: 1, height: 10 });

    const pay = createPayment({ inTxConfirmed: false });

    await counter.count(pay);

    expect(pay.inTxConfirmed).toBe(true);
    expect(pay.inConfirmations).toBe(1);
  });

  test('leaves a transfer unconfirmed while it is short of the threshold', async () => {
    config.min_confirmations_ADM = 3;

    try {
      exchangerUtils.ADM.getTransaction.mockResolvedValue({ status: true, confirmations: 2, height: 10 });

      const pay = createPayment({ inTxConfirmed: false });

      await counter.count(pay);

      expect(pay.inTxConfirmed).toBe(false);
      expect(pay.inConfirmations).toBe(2);
    } finally {
      config.min_confirmations_ADM = 1;
    }
  });

  test('derives the confirmations from the chain tip when the node reports only a height', async () => {
    exchangerUtils.DASH.getTransaction.mockResolvedValue({ status: true, confirmations: undefined, height: 100 });
    exchangerUtils.DASH.getLastBlockHeight.mockResolvedValue(104);

    const pay = createPayment({ inCurrency: 'DASH', inTxConfirmed: false });

    await counter.count(pay);

    expect(pay.inConfirmations).toBe(5);
  });

  test('accepts an InstantSend transfer without waiting for confirmations', async () => {
    exchangerUtils.DASH.getTransaction.mockResolvedValue({ status: undefined, confirmations: 0, height: undefined });

    const pay = createPayment({ inCurrency: 'DASH', inTxConfirmed: false, inTxIsInstant: true });

    await counter.count(pay);

    expect(pay.inTxConfirmed).toBe(true);
  });

  test('declines a transfer the blockchain reports as failed, and tells the user', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue({ status: false });

    const pay = createPayment({ inTxConfirmed: false });

    await counter.count(pay);

    expect(pay.transactionIsFailed).toBe(true);
    expect(pay.isFinished).toBe(true);
    expect(pay.inTxConfirmed).toBe(false);
    expect(pay.error).toBe(constants.ERRORS.TX_FAILED);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('has failed'), 'error');
    expect(messenger.sendMessage).toHaveBeenCalledWith(pay.senderId, expect.stringContaining('has failed'));
  });

  test('waits for the next tick when the transfer cannot be fetched', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(undefined);

    const pay = createPayment({ inTxConfirmed: false });

    await counter.count(pay);

    expect(pay.inTxConfirmed).toBe(false);
    expect(pay.save).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to fetch the validated Tx'));
  });

  test('quarantines a payment whose incoming coin adapter no longer exists', async () => {
    const pay = createPayment({ inCurrency: 'LSK', inTxConfirmed: false });

    await counter.count(pay);

    expect(pay.needHumanCheck).toBe(true);
    expect(pay.isFinished).toBe(true);
    expect(pay.error).toBe(constants.ERRORS.UNSUPPORTED_COIN);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('no longer supported by this bot'), 'error');
  });

  test('waits for the next tick when neither height nor confirmations are known', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue({ status: true, confirmations: 0, height: undefined });

    const pay = createPayment({ inTxConfirmed: false });

    await counter.count(pay);

    expect(pay.inTxConfirmed).toBe(false);
  });

  test('waits for the next tick when the chain tip cannot be read', async () => {
    exchangerUtils.DASH.getTransaction.mockResolvedValue({ status: true, confirmations: undefined, height: 100 });
    exchangerUtils.DASH.getLastBlockHeight.mockResolvedValue(undefined);

    const pay = createPayment({ inCurrency: 'DASH', inTxConfirmed: false });

    await counter.count(pay);

    expect(pay.inConfirmations).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to get the last DASH block height'));
  });

  test('logs and moves on when counting throws', async () => {
    exchangerUtils.ADM.getTransaction.mockRejectedValue(new Error('node exploded'));

    await expect(counter.count(createPayment())).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to get the confirmations'));
  });
});

describe('confirmationsCounter.run', () => {
  test('only considers validated transfers that are not confirmed yet', async () => {
    db.paymentsDb.find.mockResolvedValue([]);

    await counter.run();

    expect(db.paymentsDb.find).toHaveBeenCalledWith({
      isBasicChecksPassed: true,
      transactionIsValid: true,
      isFinished: false,
      transactionIsFailed: false,
      inTxConfirmed: { $ne: true },
    });
  });

  test('processes every payment in the queue', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue({ status: true, confirmations: 1, height: 10 });

    const payments = [createPayment({ _id: 'a' }), createPayment({ _id: 'b' })];

    db.paymentsDb.find.mockResolvedValue(payments);

    await counter.run();

    for (const pay of payments) {
      expect(pay.inTxConfirmed).toBe(true);
    }
  });
});
