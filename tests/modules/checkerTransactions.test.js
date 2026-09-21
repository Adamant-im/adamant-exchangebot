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
const constants = require('../../helpers/const');
const checker = require('../../modules/checkerTransactions');

describe('checkerTransactions.check', () => {
  test('asks for the bot’s own transfers and chat messages from the last processed block, oldest first', async () => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(54632450);
    api.getTransactions.mockResolvedValue({ success: true, transactions: [] });

    await checker.check();

    expect(api.getTransactions).toHaveBeenCalledWith({
      recipientId: config.address,
      types: [TransactionType.SEND, TransactionType.CHAT_MESSAGE],
      // Inclusive: a second transaction in the last processed block is not skipped.
      fromHeight: 54632450,
      returnAsset: 1,
      // Oldest first, so the checkpoint never moves past a transaction with no stored record.
      orderBy: 'height:asc',
      limit: 100,
      offset: 0,
    });
  });

  test('stops the batch at the first failure, so the checkpoint cannot move past it', async () => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(1);
    api.getTransactions.mockResolvedValue({ success: true, transactions: [{ id: 'a' }, { id: 'b' }] });
    txParser.mockRejectedValueOnce(new Error('db down'));

    await checker.check();

    expect(txParser).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('db down'));
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

describe('checkerTransactions.check — paging', () => {
  /**
   * Builds transactions to the bot, in the order the node returns them.
   *
   * @param {number} count How many
   * @param {(index: number) => number} [heightOf] Block height of the n-th transaction
   * @returns {object[]}
   */
  function transfers(count, heightOf = (index) => 1000 + Math.floor(index / 10)) {
    return Array.from({ length: count }, (_, index) => ({ id: `tx-${index}`, height: heightOf(index) }));
  }

  /**
   * Serves a list of transactions the way the node pages them.
   *
   * @param {object[]} all Every transaction above the checkpoint, oldest first
   */
  function serve(all) {
    api.getTransactions.mockImplementation(async ({ offset, limit }) => ({
      success: true,
      transactions: all.slice(offset, offset + limit),
    }));
  }

  beforeEach(() => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(1000);
    // An earlier test leaves the parser failing; these tests need it to succeed.
    txParser.mockResolvedValue(undefined);
  });

  test('reads every page of a backlog in one poll, all from the same checkpoint', async () => {
    serve(transfers(130));

    await checker.check();

    expect(txParser).toHaveBeenCalledTimes(130);
    expect(api.getTransactions).toHaveBeenCalledTimes(2);
    expect(api.getTransactions.mock.calls.map(([query]) => [query.fromHeight, query.offset])).toEqual([
      [1000, 0],
      [1000, 100],
    ]);
  });

  test('reads a block that holds more transactions for the bot than one page', async () => {
    // Blocks are limited to 25 transactions today; the poller must not rely on that.
    serve(transfers(250, () => 1000));

    await checker.check();

    expect(txParser).toHaveBeenCalledTimes(250);
    expect(txParser).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'tx-249' }));
    expect(api.getTransactions).toHaveBeenCalledTimes(3);
  });

  test('asks for one more page after a full one, and stops at an empty one', async () => {
    serve(transfers(100));

    await checker.check();

    expect(txParser).toHaveBeenCalledTimes(100);
    expect(api.getTransactions).toHaveBeenCalledTimes(2);
  });

  test('stops when the node repeats a page, as one that ignores the offset would', async () => {
    const page = transfers(100);

    api.getTransactions.mockResolvedValue({ success: true, transactions: page });

    await checker.check();

    expect(txParser).toHaveBeenCalledTimes(100);
    expect(api.getTransactions).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('as if it ignored the offset'));
  });

  test('stops the poll when a later page cannot be fetched', async () => {
    api.getTransactions
      .mockResolvedValueOnce({ success: true, transactions: transfers(100) })
      .mockResolvedValueOnce({ success: false, errorMessage: 'node down' });

    await checker.check();

    // The first page is handled; the rest is read again from the checkpoint next time.
    expect(txParser).toHaveBeenCalledTimes(100);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('node down'));
  });
});

describe('checkerTransactions.start', () => {
  test('skips a tick while the previous poll is still running', async () => {
    jest.useFakeTimers();

    let finishPoll;

    Store.getLastProcessedBlockHeight.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPoll = resolve;
        }),
    );

    try {
      const handle = checker.start();

      await jest.advanceTimersByTimeAsync(constants.TX_CHECKER_INTERVAL * 3);

      // The first poll is still waiting for its node, so the next two ticks were skipped
      // rather than reading the same page and parsing the same transactions again.
      expect(Store.getLastProcessedBlockHeight).toHaveBeenCalledTimes(1);

      clearInterval(handle);
      finishPoll(undefined);
    } finally {
      jest.useRealTimers();
    }
  });

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
