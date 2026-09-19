jest.mock('../../helpers/cryptos/exchanger', () => ({
  ADM: { getLastBlockHeight: jest.fn() },
  BTC: { getPendingIncomingTransactions: jest.fn() },
}));
jest.mock('../../modules/depositClaims', () => ({ recordObservation: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../helpers/log', () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const exchangerUtils = require('../../helpers/cryptos/exchanger');
const depositClaims = require('../../modules/depositClaims');
const watcher = require('../../modules/depositWatcher');

beforeEach(() => {
  watcher.state.clear();
  exchangerUtils.ADM.getLastBlockHeight.mockResolvedValue(500);
  exchangerUtils.BTC.getPendingIncomingTransactions.mockReset();
  depositClaims.recordObservation.mockClear();
});

test('does not trust transactions already present in the startup mempool snapshot', async () => {
  exchangerUtils.BTC.getPendingIncomingTransactions.mockResolvedValue([{ hash: 'aa'.repeat(32) }]);

  await watcher.initialize();

  expect(depositClaims.recordObservation).toHaveBeenCalledWith(
    expect.objectContaining({
      inCurrency: 'BTC',
      inTxid: 'aa'.repeat(32),
      admHeight: 500,
      reliable: false,
      source: 'btc-startup-snapshot',
    }),
  );
});

test('records a transaction added after a successful baseline as reliable first-seen evidence', async () => {
  const oldHash = 'aa'.repeat(32);
  const newHash = 'bb'.repeat(32);

  exchangerUtils.BTC.getPendingIncomingTransactions
    .mockResolvedValueOnce([{ hash: oldHash }])
    .mockResolvedValueOnce([{ hash: oldHash }, { hash: newHash }]);

  await watcher.initialize();
  depositClaims.recordObservation.mockClear();
  await watcher.poll();

  expect(depositClaims.recordObservation).toHaveBeenCalledTimes(1);
  expect(depositClaims.recordObservation).toHaveBeenCalledWith(
    expect.objectContaining({
      inCurrency: 'BTC',
      inTxid: newHash,
      admHeight: 500,
      reliable: true,
      source: 'btc-mempool',
    }),
  );
});
