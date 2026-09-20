const { TransactionType } = require('adamant-api');

const Store = require('./Store');
const api = require('./api');
const txParser = require('./incomingTxsParser');
const log = require('../helpers/log');
const config = require('./configReader');
const constants = require('../helpers/const');
const utils = require('../helpers/utils');

/** Transactions read per poll. A backlog larger than this is worked off over several ticks. */
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

    const response = await api.getTransactions({
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
    });

    if (!response.success) {
      log.warn(`Failed to get Txs in check() of ${utils.getModuleName(module.id)} module. ${response.errorMessage}.`);

      return;
    }

    // A failure stops the batch on purpose: the newer transactions are fetched again
    // on the next tick, and the checkpoint cannot move past one that failed before
    // its record was stored.
    for (const tx of response.transactions) {
      await txParser(tx);
    }
  } catch (error) {
    log.error(`Error while checking new transactions: ${error}`);
  }
}

/**
 * Starts polling for new ADAMANT transactions.
 *
 * @returns {NodeJS.Timeout} The interval handle, so tests and shutdown code can clear it
 */
function start() {
  return setInterval(() => {
    void check();
  }, constants.TX_CHECKER_INTERVAL);
}

module.exports = { check, start };
