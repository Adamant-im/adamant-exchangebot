const config = require('./configReader');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const constants = require('../helpers/const');
const log = require('../helpers/log');
const utils = require('../helpers/utils');
const { startInterval } = require('../helpers/scheduler');
const depositClaims = require('./depositClaims');

const state = new Map();
const inFlight = new Map();
const timedOut = new Set();
let admHeightInFlight;

function watchedCoins() {
  return ['BTC', 'DASH', 'DOGE', 'ETH'].filter(
    (coin) =>
      (config.known_crypto.includes(coin) || (coin === 'ETH' && config.erc20.length > 0)) &&
      exchangerUtils[coin]?.getPendingIncomingTransactions,
  );
}

function getAdmHeight() {
  if (!admHeightInFlight) {
    admHeightInFlight = exchangerUtils.ADM.getLastBlockHeight()
      .catch((error) => {
        log.warn(`Unable to read the ADAMANT height for pending-deposit evidence. ${error}`);

        return undefined;
      })
      .finally(() => {
        admHeightInFlight = undefined;
      });
  }

  return admHeightInFlight;
}

async function pollCoin(coin) {
  const adapter = exchangerUtils[coin];
  const [transactions, admHeight] = await Promise.all([adapter.getPendingIncomingTransactions(), getAdmHeight()]);

  if (!Array.isArray(transactions)) {
    throw new Error(`${coin} node returned no pending-transaction snapshot.`);
  }

  const now = utils.unix();
  const previous = state.get(coin);
  const current = new Set(transactions.map((tx) => tx.hash ?? tx.id).filter(Boolean));
  const continuous = previous && now - previous.polledAt <= constants.DEPOSIT_WATCH_INTERVAL * 2;

  for (const tx of transactions) {
    const txid = tx.hash ?? tx.id;

    if (!txid || previous?.hashes.has(txid)) {
      continue;
    }

    await depositClaims.recordObservation({
      inCurrency: coin,
      inTxid: txid,
      admHeight,
      reliable: Boolean(continuous && admHeight),
      source: continuous ? `${coin.toLowerCase()}-mempool` : `${coin.toLowerCase()}-startup-snapshot`,
      observedAt: now,
    });
  }

  state.set(coin, { hashes: current, polledAt: now });
}

function runCoinPoll(coin) {
  const running = inFlight.get(coin);

  if (running) {
    return running;
  }

  let succeeded = false;
  const operation = pollCoin(coin)
    .then(() => {
      succeeded = true;
    })
    .catch((error) => {
      state.delete(coin);
      log.warn(`Unable to observe pending ${coin} deposits. The next snapshot will require manual review. ${error}`);
    })
    .finally(() => {
      inFlight.delete(coin);

      if (timedOut.delete(coin) && succeeded) {
        log.log(`Pending ${coin} deposit observation recovered after a timeout.`);
      }
    });

  inFlight.set(coin, operation);

  return operation;
}

async function waitForCoinPoll(coin, timeoutMs) {
  const operation = runCoinPoll(coin);
  let timeout;

  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([operation.then(() => 'complete'), deadline]);

  clearTimeout(timeout);

  if (result === 'timeout' && !timedOut.has(coin)) {
    state.delete(coin);
    timedOut.add(coin);
    log.warn(
      `Pending ${coin} deposit observation exceeded ${timeoutMs} ms. The exchange bot will continue; deposits without trustworthy first-seen evidence require manual review.`,
    );
  }
}

/**
 * Polls every supported mempool before claims are validated or paid.
 *
 * A failed or timed-out coin poll invalidates its previous baseline. The next
 * successful snapshot is consequently low-confidence and cannot authorize a payout.
 *
 * @param {number} [timeoutMs] Maximum time to wait for each coin
 * @returns {Promise<void>}
 */
async function poll(timeoutMs = constants.DEPOSIT_WATCH_POLL_TIMEOUT) {
  await Promise.all(watchedCoins().map((coin) => waitForCoinPoll(coin, timeoutMs)));
}

async function initialize() {
  await poll();
  const baselined = watchedCoins().filter((coin) => state.has(coin));

  log.log(`Initialized pending-deposit observation for: ${baselined.join(', ') || 'none'}.`);
}

function start() {
  return watchedCoins().map((coin) =>
    startInterval(
      `pending ${coin} deposit watcher`,
      () => waitForCoinPoll(coin, constants.DEPOSIT_WATCH_POLL_TIMEOUT),
      constants.DEPOSIT_WATCH_INTERVAL,
    ),
  );
}

module.exports = { initialize, poll, start, state };
