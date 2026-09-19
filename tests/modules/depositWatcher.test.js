jest.mock('../../helpers/cryptos/exchanger', () => ({
  ADM: { getLastBlockHeight: jest.fn() },
  BTC: { getPendingIncomingTransactions: jest.fn() },
  ETH: { getPendingIncomingTransactions: jest.fn() },
}));
jest.mock('../../modules/depositClaims', () => ({ recordObservation: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../helpers/log', () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const exchangerUtils = require('../../helpers/cryptos/exchanger');
const constants = require('../../helpers/const');
const depositClaims = require('../../modules/depositClaims');
const log = require('../../helpers/log');
const watcher = require('../../modules/depositWatcher');

beforeEach(() => {
  watcher.state.clear();
  exchangerUtils.ADM.getLastBlockHeight.mockResolvedValue(500);
  exchangerUtils.BTC.getPendingIncomingTransactions.mockReset();
  exchangerUtils.ETH.getPendingIncomingTransactions.mockReset().mockResolvedValue([]);
  depositClaims.recordObservation.mockClear();
  log.warn.mockClear();
  log.log.mockClear();
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

test('breaks continuity after a failed poll and treats the next snapshot as untrusted', async () => {
  const hash = 'cc'.repeat(32);

  exchangerUtils.BTC.getPendingIncomingTransactions
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce([{ hash }]);

  await watcher.initialize();
  await watcher.poll();
  await watcher.poll();

  expect(depositClaims.recordObservation).toHaveBeenCalledWith(
    expect.objectContaining({
      inTxid: hash,
      reliable: false,
      source: 'btc-startup-snapshot',
    }),
  );
});

test('treats a snapshot after an excessive polling gap as untrusted', async () => {
  const hash = 'ee'.repeat(32);

  watcher.state.set('BTC', {
    hashes: new Set(),
    polledAt: Date.now() - constants.DEPOSIT_WATCH_INTERVAL * 2 - 100,
  });
  exchangerUtils.BTC.getPendingIncomingTransactions.mockResolvedValue([{ hash }]);

  await watcher.poll();

  expect(depositClaims.recordObservation).toHaveBeenCalledWith(
    expect.objectContaining({
      inTxid: hash,
      reliable: false,
      source: 'btc-startup-snapshot',
    }),
  );
});

test('returns after a stalled coin watcher without starting an overlapping request', async () => {
  const ethHash = `0x${'dd'.repeat(32)}`;
  let release;
  const stalled = new Promise((resolve) => {
    release = resolve;
  });

  exchangerUtils.BTC.getPendingIncomingTransactions.mockReturnValue(stalled);
  exchangerUtils.ETH.getPendingIncomingTransactions.mockResolvedValueOnce([{ hash: ethHash }]);

  await watcher.poll(5);

  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('exchange bot will continue'));
  expect(exchangerUtils.BTC.getPendingIncomingTransactions).toHaveBeenCalledTimes(1);
  expect(depositClaims.recordObservation).toHaveBeenCalledWith(
    expect.objectContaining({ inCurrency: 'ETH', inTxid: ethHash }),
  );

  const nextPoll = watcher.poll(50);

  expect(exchangerUtils.BTC.getPendingIncomingTransactions).toHaveBeenCalledTimes(1);
  release([]);
  await nextPoll;
});
