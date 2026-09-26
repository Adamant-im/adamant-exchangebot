const config = require('./configReader');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const constants = require('../helpers/const');
const log = require('../helpers/log');
const utils = require('../helpers/utils');
const { startInterval } = require('../helpers/scheduler');
const depositClaims = require('./depositClaims');

const state = new Map();

/** While a coin keeps failing, a summary is logged at most this often. */
const FAILURE_LOG_INTERVAL = 10 * 60 * 1000;

/**
 * Failure streak of each coin: when it started, how many polls failed, and when it was
 * last reported. A node outage would otherwise log a warning on every 5-second poll.
 *
 * @type {Map<string, {since: number, count: number, lastLoggedAt: number}>}
 */
const failures = new Map();

/**
 * Reports a failed poll: the first failure of a streak at once, then a summary at
 * most every {@link FAILURE_LOG_INTERVAL}.
 *
 * @param {string} coin Ticker
 * @param {unknown} error What went wrong
 */
function reportFailure(coin, error) {
  const now = utils.unix();
  const streak = failures.get(coin);

  if (!streak) {
    failures.set(coin, { since: now, count: 1, lastLoggedAt: now });
    log.warn(
      `Unable to observe pending ${coin} deposits. Deposits first seen after this will need manual review until observation recovers. ${error}`,
    );

    return;
  }

  streak.count += 1;

  if (now - streak.lastLoggedAt >= FAILURE_LOG_INTERVAL) {
    streak.lastLoggedAt = now;
    log.warn(
      `Pending ${coin} deposits are still not observed: ${streak.count} failed polls since ${utils.formatDate(streak.since).YYYY_MM_DD_hh_mm}. Last error: ${error}`,
    );
  }
}

/**
 * Reports the end of a failure streak, if there was one.
 *
 * @param {string} coin Ticker
 */
function reportRecovery(coin) {
  const streak = failures.get(coin);

  if (streak) {
    failures.delete(coin);
    log.info(`Pending ${coin} deposit observation recovered after ${streak.count} failed poll(s).`);
  }
}

/**
 * Coin polls in progress, each with its own state.
 *
 * @type {Map<string, {operation: Promise<void>, run: {timedOut: boolean}}>}
 */
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

/**
 * Takes one mempool snapshot of a coin and records the transfers that are new since the last one.
 *
 * A transfer is recorded as reliably first-seen only when the previous snapshot is recent
 * enough to prove it was not there before, and only while this poll is still inside its
 * deadline. The first observation of a deposit is final, so a poll that
 * {@link waitForCoinPoll} has given up on may still record what it saw, but never as
 * reliable, and never becomes the baseline for the next poll.
 *
 * @param {string} coin Ticker
 * @param {{timedOut: boolean}} run This poll's state; `timedOut` is raised by waitForCoinPoll()
 * @returns {Promise<void>}
 */
async function pollCoin(coin, run) {
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

    // Checked for every transfer: the deadline can pass while earlier ones are written.
    await depositClaims.recordObservation({
      inCurrency: coin,
      inTxid: txid,
      admHeight,
      reliable: Boolean(continuous && admHeight && !run.timedOut),
      source: continuous ? `${coin.toLowerCase()}-mempool` : `${coin.toLowerCase()}-startup-snapshot`,
      observedAt: now,
    });
  }

  // A timed-out poll has already dropped the baseline. Restoring it here would make the
  // next poll look continuous across the gap, so the next snapshot starts a fresh one.
  if (!run.timedOut) {
    state.set(coin, { hashes: current, polledAt: now });
  }
}

/**
 * Starts a poll of a coin, or joins the one already running.
 *
 * @param {string} coin Ticker
 * @returns {{operation: Promise<void>, run: {timedOut: boolean}}}
 */
function runCoinPoll(coin) {
  const running = inFlight.get(coin);

  if (running) {
    return running;
  }

  let succeeded = false;
  const run = { timedOut: false };
  const operation = pollCoin(coin, run)
    .then(() => {
      succeeded = true;
      reportRecovery(coin);
    })
    .catch((error) => {
      state.delete(coin);
      reportFailure(coin, error);
    })
    .finally(() => {
      inFlight.delete(coin);

      if (timedOut.delete(coin) && succeeded) {
        log.log(`Pending ${coin} deposit observation recovered after a timeout.`);
      }
    });

  const entry = { operation, run };

  inFlight.set(coin, entry);

  return entry;
}

/**
 * Waits for a coin poll, but no longer than the deadline.
 *
 * Giving up does not cancel the poll, so the poll is told instead: from then on it can
 * only lower confidence in what it observes, never restore it.
 *
 * @param {string} coin Ticker
 * @param {number} timeoutMs Deadline, in milliseconds
 * @returns {Promise<void>}
 */
async function waitForCoinPoll(coin, timeoutMs) {
  const { operation, run } = runCoinPoll(coin);
  let timeout;

  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([operation.then(() => 'complete'), deadline]);

  clearTimeout(timeout);

  if (result === 'timeout') {
    run.timedOut = true;
    state.delete(coin);
  }

  if (result === 'timeout' && !timedOut.has(coin)) {
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
