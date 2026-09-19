const config = require('./configReader');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const constants = require('../helpers/const');
const log = require('../helpers/log');
const utils = require('../helpers/utils');
const { startInterval } = require('../helpers/scheduler');
const depositClaims = require('./depositClaims');

const state = new Map();

function watchedCoins() {
  return ['BTC', 'DASH', 'DOGE', 'ETH'].filter(
    (coin) =>
      (config.known_crypto.includes(coin) || (coin === 'ETH' && config.erc20.length > 0)) &&
      exchangerUtils[coin]?.getPendingIncomingTransactions,
  );
}

async function pollCoin(coin, admHeight, now) {
  const adapter = exchangerUtils[coin];
  const transactions = await adapter.getPendingIncomingTransactions();

  if (!Array.isArray(transactions)) {
    return;
  }

  const previous = state.get(coin);
  const current = new Set(transactions.map((tx) => tx.hash ?? tx.id).filter(Boolean));
  const continuous = previous && now - previous.polledAt <= constants.DEPOSIT_WATCH_INTERVAL * 3;

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

/**
 * Polls every supported mempool before claims are validated or paid.
 *
 * A failed coin poll leaves its previous state untouched. The next successful poll
 * after a long gap is consequently low-confidence and cannot authorize a payout.
 *
 * @returns {Promise<void>}
 */
async function poll() {
  const now = utils.unix();
  const admHeight = await exchangerUtils.ADM.getLastBlockHeight();

  await Promise.all(
    watchedCoins().map(async (coin) => {
      try {
        await pollCoin(coin, admHeight, now);
      } catch (error) {
        log.warn(`Unable to observe pending ${coin} deposits. The next snapshot will require manual review. ${error}`);
      }
    }),
  );
}

async function initialize() {
  await poll();
  log.log(`Initialized pending-deposit observation for: ${watchedCoins().join(', ') || 'none'}.`);
}

function start() {
  return startInterval('pending deposit watcher', poll, constants.DEPOSIT_WATCH_INTERVAL);
}

module.exports = { initialize, poll, start, state };
