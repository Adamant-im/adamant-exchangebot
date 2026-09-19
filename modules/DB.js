const { MongoClient } = require('mongodb');

const config = require('./configReader');
const log = require('../helpers/log');
const model = require('../helpers/dbModel');

/** Give up on an unreachable MongoDB quickly instead of hanging the bot's startup. */
const SERVER_SELECTION_TIMEOUT_MS = 3000;

/**
 * Indexes backing the queries the interval workers run every 10–20 seconds.
 *
 * Creating an index that already exists with the same definition is a no-op, so
 * this runs safely on every start.
 */
const INDEXES = {
  incomingtxs: [
    { key: { senderId: 1, date: -1 } },
    { key: { senderId: 1, isSpam: 1, date: -1 } },
    { key: { senderId: 1, messageDirective: 1, date: -1 } },
  ],
  payments: [
    { key: { inTxid: 1 } },
    { key: { senderId: 1, inUpdateState: 1 } },
    { key: { senderId: 1, date: -1 } },
    { key: { isFinished: 1, isBasicChecksPassed: 1, transactionIsValid: 1 } },
    { key: { isFinished: 1, inTxConfirmed: 1, needToSendBack: 1 } },
    { key: { isFinished: 1, outTxid: 1, sentBackTx: 1 } },
  ],
  deposits: [{ key: { reservedBy: 1 } }, { key: { firstSeenAt: 1 } }],
  depositclaims: [{ key: { depositKey: 1, status: 1, registeredAt: 1 } }, { key: { senderId: 1, registeredAt: -1 } }],
};

const client = new MongoClient(config.db_url, {
  serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
});

const collections = { client };

/**
 * Installs a property that throws until the database connection is ready.
 *
 * Without this, code that runs before the connection resolves fails with an
 * anonymous `Cannot read properties of undefined`, and an incoming transfer can be
 * dropped without anyone noticing. Awaiting {@link collections.ready} is the fix;
 * this makes forgetting to do so loud.
 *
 * @param {string} name Collection property name
 */
function defineTripwire(name) {
  Object.defineProperty(collections, name, {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(`Database collection '${name}' was used before the connection was ready. Await db.ready first.`);
    },
  });
}

['db', 'systemDb', 'incomingTxsDb', 'paymentsDb', 'depositsDb', 'depositClaimsDb'].forEach(defineTripwire);

/**
 * Replaces a tripwire with the real value.
 *
 * @param {string} name Collection property name
 * @param {*} value Value to expose
 */
function defineCollection(name, value) {
  Object.defineProperty(collections, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

/**
 * Creates the indexes listed in {@link INDEXES}.
 *
 * A failure here is not fatal: the bot still works, only more slowly, and an
 * operator running with a restricted database user should not be locked out.
 *
 * @param {import('mongodb').Db} db Connected database
 * @returns {Promise<void>}
 */
async function ensureIndexes(db) {
  for (const [collectionName, indexes] of Object.entries(INDEXES)) {
    try {
      await db.collection(collectionName).createIndexes(indexes);
    } catch (error) {
      log.warn(`Unable to create indexes for the '${collectionName}' collection. ${error.message}.`);
    }
  }
}

/**
 * Resolves once MongoDB is connected and the collections are usable.
 *
 * Everything that touches the database must await this first.
 *
 * @type {Promise<typeof collections>}
 */
collections.ready = client.connect().then(async (connected) => {
  const db = connected.db(config.db_name);

  defineCollection('db', db);
  defineCollection('systemDb', model(db.collection('systems')));
  defineCollection('incomingTxsDb', model(db.collection('incomingtxs')));
  defineCollection('paymentsDb', model(db.collection('payments')));
  defineCollection('depositsDb', model(db.collection('deposits')));
  defineCollection('depositClaimsDb', model(db.collection('depositclaims')));

  await ensureIndexes(db);

  log.log(`${config.notifyName} successfully connected to the '${config.db_name}' MongoDB database.`);

  return collections;
});

// Keep a rejected connection from becoming an unhandled rejection before the
// caller gets a chance to await `ready`. The caller still sees the rejection.
collections.ready.catch(() => {});

/**
 * Closes the MongoDB connection.
 *
 * @returns {Promise<void>}
 */
collections.close = () => client.close();

module.exports = collections;
