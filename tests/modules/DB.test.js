jest.mock('mongodb', () => {
  const createIndexes = jest.fn().mockResolvedValue(['index']);
  const collection = jest.fn().mockReturnValue({ createIndexes });
  const db = jest.fn().mockReturnValue({ collection, databaseName: 'exchangerdb_test' });
  const close = jest.fn().mockResolvedValue(undefined);

  const state = { connect: jest.fn(), db, collection, createIndexes, close };

  class MongoClient {
    constructor(url, options) {
      state.url = url;
      state.options = options;
      this.db = db;
      this.close = close;
      this.connect = () => state.connect().then(() => this);
    }
  }

  return { MongoClient, __state: state };
});
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const mongodb = require('mongodb');

const config = require('../../modules/configReader');
const log = require('../../helpers/log');

/**
 * Loads a fresh copy of the DB module with the mocked driver.
 *
 * @returns {object} The module's exports
 */
function loadDb() {
  let db;

  jest.isolateModules(() => {
    db = require('../../modules/DB');
  });

  return db;
}

beforeEach(() => {
  mongodb.__state.connect.mockResolvedValue(undefined);
  mongodb.__state.createIndexes.mockResolvedValue(['index']);
});

describe('modules/DB', () => {
  test('connects with the configured URL and a short server-selection timeout', () => {
    loadDb();

    expect(mongodb.__state.url).toBe(config.db_url);
    expect(mongodb.__state.options.serverSelectionTimeoutMS).toBe(3000);
  });

  test('passes no options the modern driver rejects', () => {
    loadDb();

    expect(mongodb.__state.options).not.toHaveProperty('useNewUrlParser');
    expect(mongodb.__state.options).not.toHaveProperty('useUnifiedTopology');
  });

  test('opens the configured database and its three collections', async () => {
    const db = loadDb();

    await db.ready;

    expect(mongodb.__state.db).toHaveBeenCalledWith(config.db_name);
    expect(mongodb.__state.collection.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(['systems', 'incomingtxs', 'payments']),
    );
  });

  test('creates the indexes the interval workers rely on', async () => {
    const db = loadDb();

    await db.ready;

    expect(mongodb.__state.createIndexes).toHaveBeenCalled();
  });

  test('starts without indexes rather than refusing to run', async () => {
    mongodb.__state.createIndexes.mockRejectedValue(new Error('not authorized'));

    const db = loadDb();

    await expect(db.ready).resolves.toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to create indexes'));
  });

  test('throws a clear error when a collection is used before the connection is ready', () => {
    const db = loadDb();

    expect(() => db.paymentsDb).toThrow(/was used before the connection was ready/);
    expect(() => db.incomingTxsDb).toThrow(/Await db.ready first/);
  });

  test('exposes the collections once the connection is ready', async () => {
    const db = loadDb();

    await db.ready;

    expect(db.paymentsDb).toBeDefined();
    expect(db.incomingTxsDb).toBeDefined();
    expect(db.systemDb).toBeDefined();
    expect(db.db).toBeDefined();
  });

  test('surfaces a connection failure to the caller without crashing the process', async () => {
    mongodb.__state.connect.mockRejectedValue(new Error('ECONNREFUSED'));

    const db = loadDb();

    await expect(db.ready).rejects.toThrow('ECONNREFUSED');
  });

  test('can close the connection', async () => {
    const db = loadDb();

    await db.ready;
    await db.close();

    expect(mongodb.__state.close).toHaveBeenCalled();
  });
});
