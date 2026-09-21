const { TransactionType } = require('adamant-api');

const Store = require('./Store');
const api = require('./api');
const txParser = require('./incomingTxsParser');
const log = require('../helpers/log');
const config = require('./configReader');
const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const { startInterval } = require('../helpers/scheduler');

/**
 * Transactions read per request.
 *
 * A poll does not depend on how many transactions a block can hold: a block with more
 * transactions for the bot than one page is read in full, on its own; see check().
 */
const CHECK_PAGE_SIZE = 100;

/**
 * Filters every request shares: the bot's incoming transfers and chat messages, with
 * their contents.
 *
 * @returns {object}
 */
function incomingQuery() {
  return {
    recipientId: config.address,
    // Direct transfers and in-chat messages; a transfer with a comment is both.
    types: [TransactionType.SEND, TransactionType.CHAT_MESSAGE],
    returnAsset: 1,
  };
}

/**
 * Hands transactions to the parser, one after another.
 *
 * A failure stops the poll on purpose: newer transactions are fetched again on the next
 * tick, and the checkpoint cannot move past one that failed before its record was stored.
 *
 * @param {object[]} transactions ADAMANT transactions
 * @returns {Promise<void>}
 */
async function parseAll(transactions) {
  for (const tx of transactions) {
    await txParser(tx);
  }
}

/**
 * Checks that a page is what was asked for: every row at or above `fromHeight`, and
 * blocks in ascending order.
 *
 * A node that ignored the filter or the order would make the poll skip transactions,
 * or never finish.
 *
 * @param {object[]} transactions Page returned by the node
 * @param {number} fromHeight Lowest height asked for
 * @returns {boolean}
 */
function isOldestFirstFrom(transactions, fromHeight) {
  return transactions.every(
    (tx, index) =>
      Number.isInteger(tx.height) &&
      tx.height >= fromHeight &&
      (index === 0 || tx.height >= transactions[index - 1].height),
  );
}

/**
 * Reads and parses every transaction for the bot in one block.
 *
 * The block is read in `id` order. The `id` is unique and a confirmed block does not
 * change, so the offset pages neither skip nor repeat a row, however many transactions
 * the block holds.
 *
 * @param {number} height Block height
 * @returns {Promise<boolean>} Whether the whole block was read; `false` ends the poll
 */
async function readBlock(height) {
  const seen = new Set();
  let offset = 0;
  let isPageFull = true;

  while (isPageFull) {
    const response = await api.getTransactions({
      ...incomingQuery(),
      fromHeight: height,
      toHeight: height,
      orderBy: 'id:asc',
      limit: CHECK_PAGE_SIZE,
      offset,
    });

    if (!response.success) {
      log.warn(
        `Failed to get the Txs of block ${height} in check() of ${utils.getModuleName(module.id)} module. ${response.errorMessage}.`,
      );

      return false;
    }

    const { transactions = [] } = response;

    // A node that ignored the height filter or the offset would return rows of other
    // blocks, or the same page forever.
    if (transactions.some((tx) => tx.height !== height || seen.has(tx.id))) {
      log.warn(
        `The node returned Txs outside block ${height}, or the same Txs again, in check() of ${utils.getModuleName(module.id)} module. Stopping this poll.`,
      );

      return false;
    }

    transactions.forEach((tx) => seen.add(tx.id));
    await parseAll(transactions);

    isPageFull = transactions.length >= CHECK_PAGE_SIZE;
    offset += CHECK_PAGE_SIZE;
  }

  return true;
}

/**
 * Fetches ADAMANT transactions addressed to the bot and hands them to the parser.
 *
 * The socket subscription delivers new transactions instantly, but it can miss
 * them across a reconnect, so this poller closes the gap by replaying everything
 * above the last processed block.
 *
 * Transactions are handled block by block, oldest first, so the checkpoint only ever
 * moves past transactions that already have a stored record. Newest-first processing
 * could move it past an older transaction that then failed, and that transaction would
 * be lost.
 *
 * The node sorts by a single field, and sorting by height leaves the rows of one block in
 * no defined order: offset pages by height could skip or repeat rows inside a block. So a
 * page ordered by height is only used to find the next blocks. Every block below its last
 * one is complete on the page, because by height all its rows sort first. The last block
 * may be cut anywhere, so it is read on its own with readBlock().
 *
 * @returns {Promise<void>}
 */
async function check() {
  try {
    const lastProcessedBlockHeight = await Store.getLastProcessedBlockHeight();

    if (!lastProcessedBlockHeight) {
      log.warn(
        `Unable to get the last processed ADM block in check() of ${utils.getModuleName(module.id)} module. Will try next time.`,
      );

      return;
    }

    // Inclusive: the last processed block is read again, so a second transaction in that
    // block is not skipped when the first one moved the checkpoint. Already handled
    // transactions are de-duplicated by the parser.
    let fromHeight = lastProcessedBlockHeight;
    let isPageFull = true;

    // Each full page moves `fromHeight` past at least one block, so the loop always ends.
    while (isPageFull) {
      const response = await api.getTransactions({
        ...incomingQuery(),
        fromHeight,
        orderBy: 'height:asc',
        limit: CHECK_PAGE_SIZE,
      });

      if (!response.success) {
        log.warn(`Failed to get Txs in check() of ${utils.getModuleName(module.id)} module. ${response.errorMessage}.`);

        return;
      }

      const { transactions = [] } = response;

      if (!isOldestFirstFrom(transactions, fromHeight)) {
        log.warn(
          `The node returned Txs below height ${fromHeight} or out of height order in check() of ${utils.getModuleName(module.id)} module. Stopping this poll.`,
        );

        return;
      }

      isPageFull = transactions.length >= CHECK_PAGE_SIZE;

      if (!isPageFull) {
        // A short page holds every transaction from `fromHeight` on.
        await parseAll(transactions);
      } else {
        const lastHeight = transactions[transactions.length - 1].height;

        await parseAll(transactions.filter((tx) => tx.height < lastHeight));

        if (!(await readBlock(lastHeight))) {
          return;
        }

        fromHeight = lastHeight + 1;
      }
    }
  } catch (error) {
    log.error(`Error while checking new transactions: ${error}`);
  }
}

/**
 * Starts polling for new ADAMANT transactions.
 *
 * A slow node can make one poll outlast the interval. Overlapping polls would read the
 * same page and hand the same transactions to the parser twice, so a tick that arrives
 * while the previous poll is still working is skipped.
 *
 * @returns {NodeJS.Timeout} The interval handle, so tests and shutdown code can clear it
 */
function start() {
  return startInterval('transaction checker', check, constants.TX_CHECKER_INTERVAL);
}

module.exports = { check, start };
