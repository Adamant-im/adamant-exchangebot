jest.mock('../../modules/DB', () => ({
  systemDb: { findOne: jest.fn(), db: { updateOne: jest.fn().mockResolvedValue({ acknowledged: true }) } },
}));
jest.mock('../../helpers/cryptos/exchanger', () => ({ ADM: { getLastBlockHeight: jest.fn() } }));
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const db = require('../../modules/DB');
const exchangerUtils = require('../../helpers/cryptos/exchanger');
const log = require('../../helpers/log');
const Store = require('../../modules/Store');

beforeEach(() => {
  Store.lastProcessedBlockHeight = undefined;
  db.systemDb.db.updateOne.mockResolvedValue({ acknowledged: true });
});

describe('Store.getLastProcessedBlockHeight', () => {
  test('restores the height from the database', async () => {
    db.systemDb.findOne.mockResolvedValue({ lastProcessedBlockHeight: 54632450 });

    await expect(Store.getLastProcessedBlockHeight()).resolves.toBe(54632450);
    expect(Store.lastProcessedBlockHeight).toBe(54632450);
  });

  test('serves later calls from memory', async () => {
    db.systemDb.findOne.mockResolvedValue({ lastProcessedBlockHeight: 54632450 });

    await Store.getLastProcessedBlockHeight();
    await Store.getLastProcessedBlockHeight();

    expect(db.systemDb.findOne).toHaveBeenCalledTimes(1);
  });

  test('starts from the current chain height on a first run', async () => {
    db.systemDb.findOne.mockResolvedValue(null);
    exchangerUtils.ADM.getLastBlockHeight.mockResolvedValue(54632450);

    await expect(Store.getLastProcessedBlockHeight()).resolves.toBe(54632450);
    expect(db.systemDb.db.updateOne).toHaveBeenCalledWith(
      {},
      { $set: { lastProcessedBlockHeight: 54632450 } },
      { upsert: true },
    );
  });

  test('returns undefined when the chain height cannot be read, so the caller retries', async () => {
    db.systemDb.findOne.mockResolvedValue(null);
    exchangerUtils.ADM.getLastBlockHeight.mockResolvedValue(undefined);

    await expect(Store.getLastProcessedBlockHeight()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to store the last ADM block'));
  });
});

describe('Store.updateLastProcessedBlockHeight', () => {
  test('advances the height', async () => {
    Store.lastProcessedBlockHeight = 100;

    await Store.updateLastProcessedBlockHeight(200);

    expect(Store.lastProcessedBlockHeight).toBe(200);
  });

  test('never rewinds the height, because transactions arrive out of order', async () => {
    Store.lastProcessedBlockHeight = 200;

    await Store.updateLastProcessedBlockHeight(100);

    expect(Store.lastProcessedBlockHeight).toBe(200);
    expect(db.systemDb.db.updateOne).not.toHaveBeenCalled();
  });

  test('ignores a missing height, as socket transactions have none', async () => {
    Store.lastProcessedBlockHeight = 200;

    await Store.updateLastProcessedBlockHeight(undefined);

    expect(Store.lastProcessedBlockHeight).toBe(200);
    expect(db.systemDb.db.updateOne).not.toHaveBeenCalled();
  });

  test('accepts the first height when none is known yet', async () => {
    await Store.updateLastProcessedBlockHeight(100);

    expect(Store.lastProcessedBlockHeight).toBe(100);
  });
});
