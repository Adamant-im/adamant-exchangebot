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
    });
  });

  test('stops the batch at the first failure, so the checkpoint cannot move past it', async () => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(1);
    api.getTransactions.mockResolvedValue({
      success: true,
      transactions: [
        { id: 'a', height: 1 },
        { id: 'b', height: 1 },
      ],
    });
    txParser.mockRejectedValueOnce(new Error('db down'));

    await checker.check();

    expect(txParser).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  test('hands every transaction to the parser', async () => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(1);
    api.getTransactions.mockResolvedValue({
      success: true,
      transactions: [
        { id: 'a', height: 1 },
        { id: 'b', height: 2 },
      ],
    });

    await checker.check();

    expect(txParser).toHaveBeenCalledTimes(2);
    expect(txParser).toHaveBeenCalledWith({ id: 'a', height: 1 });
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
    api.getTransactions.mockResolvedValue({ success: true, transactions: [{ id: 'a', height: 1 }] });
    txParser.mockRejectedValue(new Error('parser exploded'));

    await expect(checker.check()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Error while checking new transactions'));
  });
});

describe('checkerTransactions.check — paging', () => {
  const CHECKPOINT = 1000;

  /**
   * Builds transactions to the bot.
   *
   * @param {number} count How many
   * @param {(index: number) => number} [heightOf] Block height of the n-th transaction
   * @returns {object[]}
   */
  function transfers(count, heightOf = (index) => CHECKPOINT + Math.floor(index / 10)) {
    return Array.from({ length: count }, (_, index) => ({
      id: `tx-${String(index).padStart(4, '0')}`,
      height: heightOf(index),
    }));
  }

  /**
   * A deterministic number that orders the same rows differently for every request.
   *
   * @param {string} id Transaction ID
   * @param {number} request Request number
   * @returns {number}
   */
  function scramble(id, request) {
    let hash = Math.imul(request, 2654435761) >>> 0;

    for (const char of id) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    }

    return hash;
  }

  /**
   * Stands in for the node's transaction list: it filters by height, sorts by the one
   * field asked for, and pages with limit and offset.
   *
   * Like PostgreSQL, sorting by height leaves the rows of one block in no defined order:
   * here they come back in a different order on every request.
   *
   * @param {object[]} all Transactions the node holds for the bot
   * @param {{ignoreOffset?: boolean, ignoreFromHeight?: boolean}} [quirks] Misbehavior to simulate
   */
  function node(all, { ignoreOffset = false, ignoreFromHeight = false } = {}) {
    let request = 0;

    api.getTransactions.mockImplementation(async ({ fromHeight, toHeight, orderBy, limit, offset = 0 }) => {
      request += 1;

      const rows = all.filter(
        (tx) => (ignoreFromHeight || tx.height >= fromHeight) && (toHeight === undefined || tx.height <= toHeight),
      );

      if (orderBy === 'id:asc') {
        rows.sort((a, b) => a.id.localeCompare(b.id));
      } else {
        rows.sort((a, b) => a.height - b.height || scramble(a.id, request) - scramble(b.id, request));
      }

      const start = ignoreOffset ? 0 : offset;

      return { success: true, transactions: rows.slice(start, start + limit) };
    });
  }

  /**
   * IDs of the transactions the parser received, in order.
   *
   * @returns {string[]}
   */
  function parsedIds() {
    return txParser.mock.calls.map(([tx]) => tx.id);
  }

  beforeEach(() => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(CHECKPOINT);
    // An earlier test leaves the parser failing; these tests need it to succeed.
    txParser.mockResolvedValue(undefined);
  });

  test('reads a backlog across many blocks in one poll, each transaction once', async () => {
    node(transfers(130));

    await checker.check();

    expect(parsedIds()).toHaveLength(130);
    expect(new Set(parsedIds()).size).toBe(130);
  });

  test('reads a block with more transactions for the bot than one page, in whatever order the node sorts it', async () => {
    // Blocks hold at most 25 transactions today. The poller must not rely on that, and
    // paging this block by height would skip and repeat rows, since their order changes.
    node(transfers(250, () => CHECKPOINT));

    await checker.check();

    expect(parsedIds()).toHaveLength(250);
    expect(new Set(parsedIds()).size).toBe(250);
    expect(api.getTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ fromHeight: CHECKPOINT, toHeight: CHECKPOINT, orderBy: 'id:asc', offset: 200 }),
    );
  });

  test('hands blocks to the parser oldest first, so the checkpoint never passes an unread transaction', async () => {
    node(transfers(300, (index) => CHECKPOINT + Math.floor(index / 37)));

    await checker.check();

    const heights = txParser.mock.calls.map(([tx]) => tx.height);

    expect(heights).toHaveLength(300);
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
  });

  test('reads to the end when the last page is exactly full', async () => {
    node(transfers(100));

    await checker.check();

    expect(new Set(parsedIds()).size).toBe(100);
    // The height page, the block it cut, then an empty page above it.
    expect(api.getTransactions).toHaveBeenLastCalledWith(expect.objectContaining({ fromHeight: CHECKPOINT + 10 }));
  });

  test('stops when the node ignores the offset inside a block', async () => {
    node(
      transfers(250, () => CHECKPOINT),
      { ignoreOffset: true },
    );

    await checker.check();

    expect(new Set(parsedIds()).size).toBe(100);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('or the same Txs again'));
  });

  test('stops when the node ignores the height filter', async () => {
    Store.getLastProcessedBlockHeight.mockResolvedValue(CHECKPOINT + 5);
    node(transfers(120), { ignoreFromHeight: true });

    await checker.check();

    expect(txParser).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`below height ${CHECKPOINT + 5}`));
  });

  test('stops, keeping what it handled, when a block cannot be read', async () => {
    node(transfers(130));
    api.getTransactions.mockImplementation(async (query) =>
      query.orderBy === 'id:asc'
        ? { success: false, errorMessage: 'node down' }
        : { success: true, transactions: transfers(130).slice(0, 100) },
    );

    await checker.check();

    // The complete blocks below the cut one are handled; the next poll reads the rest.
    expect(parsedIds()).toHaveLength(90);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to get the Txs of block'));
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
