jest.mock('../../modules/api', () => ({ getTransactions: jest.fn() }));
jest.mock('../../modules/Store', () => ({ getLastProcessedBlockHeight: jest.fn() }));
jest.mock('../../modules/incomingTxsParser', () => jest.fn().mockResolvedValue(undefined));
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const { TransactionType } = require('adamant-api');

const api = require('../../modules/api');
const Store = require('../../modules/Store');
const txParser = require('../../modules/incomingTxsParser');
const log = require('../../helpers/log');
const config = require('../../modules/configReader');
const checker = require('../../modules/checkerTransactions');

describe('checkerTransactions.check', () => {
  test('asks only for the bot’s own transfers and chat messages above the last processed block', async () => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(54632450);
    api.getTransactions.mockResolvedValue({ success: true, transactions: [] });

    await checker.check();

    expect(api.getTransactions).toHaveBeenCalledWith({
      recipientId: config.address,
      types: [TransactionType.SEND, TransactionType.CHAT_MESSAGE],
      fromHeight: 54632451,
      returnAsset: 1,
      orderBy: 'timestamp:desc',
    });
  });

  test('hands every transaction to the parser', async () => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(1);
    api.getTransactions.mockResolvedValue({ success: true, transactions: [{ id: 'a' }, { id: 'b' }] });

    await checker.check();

    expect(txParser).toHaveBeenCalledTimes(2);
    expect(txParser).toHaveBeenCalledWith({ id: 'a' });
  });

  test('does nothing until the last processed block is known', async () => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(undefined);

    await checker.check();

    expect(api.getTransactions).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to get the last processed ADM block'));
  });

  test('logs a failed request and waits for the next tick', async () => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(1);
    api.getTransactions.mockResolvedValue({ success: false, errorMessage: 'node down' });

    await checker.check();

    expect(txParser).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to get Txs'));
  });

  test('logs and moves on when the parser throws', async () => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(1);
    api.getTransactions.mockResolvedValue({ success: true, transactions: [{ id: 'a' }] });
    txParser.mockRejectedValue(new Error('parser exploded'));

    await expect(checker.check()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Error while checking new transactions'));
  });
});

describe('checkerTransactions.start', () => {
  test('returns an interval handle the caller can clear', () => {
    jest.useFakeTimers();

    try {
      const handle = checker.start();

      expect(handle).toBeDefined();
      clearInterval(handle);
    } finally {
      jest.useRealTimers();
    }
  });
});
