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
 * A poll keeps reading pages until one comes back short, so it does not depend on how
 * many transactions a block can hold: a block with more transactions for the bot than
 * one page is read in full, the next page continuing inside the same block.
 */
const CHECK_PAGE_SIZE = 100;

/**
 * Fetches ADAMANT transactions addressed to the bot and hands them to the parser.
 *
 * The socket subscription delivers new transactions instantly, but it can miss
 * them across a reconnect, so this poller closes the gap by replaying everything
 * above the last processed block.
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

    // One query for the whole poll: the checkpoint is read once, so the offsets below
    // address a single result set. It is ordered oldest first, and new transactions can
    // only join it at the end, in new blocks, so no page shifts under the next one.
    const query = {
      recipientId: config.address,
      // Direct transfers and in-chat messages; a transfer with a comment is both.
      types: [TransactionType.SEND, TransactionType.CHAT_MESSAGE],
      // Inclusive: the last processed block is read again, so a second transaction
      // in that block is not skipped when the first one moved the checkpoint.
      // Already handled transactions are de-duplicated by the parser.
      fromHeight: lastProcessedBlockHeight,
      returnAsset: 1,
      // Oldest first, so the checkpoint only ever moves past transactions that
      // already have a stored record. Newest-first processing could move it past an
      // older transaction that then failed, and that transaction would be lost.
      orderBy: 'height:asc',
      limit: CHECK_PAGE_SIZE,
    };
    const seen = new Set();
    let offset = 0;
    let isPageFull = true;

    while (isPageFull) {
      const response = await api.getTransactions({ ...query, offset });

      if (!response.success) {
        log.warn(`Failed to get Txs in check() of ${utils.getModuleName(module.id)} module. ${response.errorMessage}.`);

        return;
      }

      const { transactions = [] } = response;

      // A node that ignores `offset` would return the same page on every request, and
      // this loop would never end. The next poll starts over from the checkpoint.
      if (transactions.some((tx) => seen.has(tx.id))) {
        log.warn(
          `The node returned the same Txs again at offset ${offset} in check() of ${utils.getModuleName(module.id)} module, as if it ignored the offset. Stopping this poll.`,
        );

        return;
      }

      // A failure stops the poll on purpose: the newer transactions are fetched again
      // on the next tick, and the checkpoint cannot move past one that failed before
      // its record was stored.
      for (const tx of transactions) {
        seen.add(tx.id);
        await txParser(tx);
      }

      isPageFull = transactions.length >= CHECK_PAGE_SIZE;
      offset += CHECK_PAGE_SIZE;
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
