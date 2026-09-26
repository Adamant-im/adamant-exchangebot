const { TransactionType } = require('adamant-api');

const config = require('./modules/configReader');
const log = require('./helpers/log');
const notify = require('./helpers/notify');
const db = require('./modules/DB');
const api = require('./modules/api');
const exchangerUtils = require('./helpers/cryptos/exchanger');
const txParser = require('./modules/incomingTxsParser');
const checker = require('./modules/checkerTransactions');
const confirmationsCounter = require('./modules/confirmationsCounter');
const deepExchangeValidator = require('./modules/deepExchangeValidator');
const exchangePayer = require('./modules/exchangePayer');
const sendBack = require('./modules/sendBack');
const sentTxChecker = require('./modules/sentTxChecker');
const depositClaims = require('./modules/depositClaims');
const depositWatcher = require('./modules/depositWatcher');
const { startInterval } = require('./helpers/scheduler');

const doClearDB = process.argv.includes('clear_db');

/** How often stored incoming transfers that never finished are retried. */
const INCOMING_REPLAY_INTERVAL = 60 * 1000;

/**
 * Drops every collection the bot owns.
 *
 * This discards all knowledge of in-flight exchanges, so the bot must be stopped
 * afterwards rather than left running against an empty database.
 *
 * @returns {Promise<void>}
 */
async function clearDatabase() {
  log.warn('Clearing the database…');

  for (const collection of [db.systemDb, db.incomingTxsDb, db.paymentsDb, db.depositsDb, db.depositClaimsDb]) {
    try {
      await collection.db.drop();
    } catch (error) {
      // A collection that was never created cannot be dropped, which is not a problem.
      if (error.codeName !== 'NamespaceNotFound') {
        throw error;
      }
    }
  }

  notify(`*${config.notifyName}: the database is cleared*. Stop the bot manually now.`, 'info');
}

/**
 * Waits until the API client has finished its first node health check.
 *
 * @returns {Promise<void>}
 */
function waitForApi() {
  return new Promise((resolve) => api.onReady(resolve));
}

/**
 * Starts the bot: connect, recover, subscribe, then run the payment pipeline.
 *
 * The order matters. The database must be usable before any transaction is handled,
 * interrupted payouts must be reconciled before new ones are sent, and the coin
 * adapters need a working ADM node because they derive their state from it.
 *
 * @returns {Promise<void>}
 */
async function start() {
  await db.ready;

  if (doClearDB) {
    await clearDatabase();

    return;
  }

  await waitForApi();

  exchangerUtils.init();

  // Migrate and audit persisted payments before any worker can validate or pay one.
  // The unique reservation index is intentionally installed only after the audit.
  await depositClaims.initialize();

  await exchangerUtils.updateCryptoRates();
  exchangerUtils.startRatesUpdates();

  if (!exchangerUtils.currencies) {
    // Without rates the bot cannot price an exchange, so it refunds instead of quoting.
    // The rate updater keeps retrying, but an operator should know the bot started blind.
    notify(
      `${config.notifyName} started without exchange rates: the InfoService did not answer. Incoming exchanges will be refunded until rates arrive.`,
      'warn',
    );
  }

  await exchangerUtils.startCoinUpdates();

  // Try to establish mempool baselines before accepting new chat claims. This is
  // time-bounded: an unavailable watcher cannot stop the rest of the bot, and any
  // deposit without trustworthy first-seen evidence requires manual settlement.
  await depositWatcher.initialize();

  // A payout that was in flight when the previous run stopped may or may not have
  // been broadcast. Flag those before the workers can send anything new.
  await exchangePayer.reconcileInterrupted();
  await sendBack.reconcileInterrupted();

  if (api.socket) {
    api.socket.on(TransactionType.SEND, txParser);
    api.socket.on(TransactionType.CHAT_MESSAGE, txParser);
  }

  // Finish incoming transfers whose handler did not complete in a previous run,
  // before the poller moves on to new ones.
  await txParser.replayUnprocessed();
  startInterval('incoming replay', () => txParser.replayUnprocessed(), INCOMING_REPLAY_INTERVAL);

  checker.start();
  depositWatcher.start();
  deepExchangeValidator.start();
  confirmationsCounter.start();
  exchangePayer.start();
  sendBack.start();
  sentTxChecker.start();

  notify(`*${config.notifyName} started* for the address _${config.address}_ (ver. ${config.version}).`, 'info');
}

start().catch((error) => {
  notify(`${config.notifyName} failed to start. Error: ${error}`, 'error');
  process.exit(1);
});
