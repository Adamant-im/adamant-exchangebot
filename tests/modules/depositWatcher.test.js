jest.mock('../../helpers/cryptos/exchanger', () => ({
  ADM: { getLastBlockHeight: jest.fn() },
  BTC: { getPendingIncomingTransactions: jest.fn() },
  ETH: { getPendingIncomingTransactions: jest.fn() },
}));
jest.mock('../../modules/depositClaims', () => ({ recordObservation: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../helpers/log', () => ({ log: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

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
  log.info.mockClear();
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

describe('reporting a failing watcher', () => {
  /** A fresh module each time: the failure streaks are module state. */
  let isolated;
  let isolatedExchanger;
  let isolatedLog;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    jest.resetModules();
    isolated = require('../../modules/depositWatcher');
    isolatedExchanger = require('../../helpers/cryptos/exchanger');
    isolatedLog = require('../../helpers/log');
    isolatedExchanger.ADM.getLastBlockHeight.mockResolvedValue(500);
    isolatedExchanger.ETH.getPendingIncomingTransactions.mockReset().mockResolvedValue([]);
    isolatedExchanger.BTC.getPendingIncomingTransactions.mockReset();
    isolatedLog.warn.mockClear();
    isolatedLog.info.mockClear();
  });

  afterEach(() => {
    Date.now.mockRestore();
  });

  test('reports the first failure, then stays quiet until the streak is old enough', async () => {
    isolatedExchanger.BTC.getPendingIncomingTransactions.mockRejectedValue(new Error('node down'));

    await isolated.poll();
    await isolated.poll();
    await isolated.poll();

    // Once per streak, not once per 5-second poll: that would be about 35,000 lines a day.
    expect(isolatedLog.warn).toHaveBeenCalledTimes(1);
    expect(isolatedLog.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to observe pending BTC deposits'));
  });

  test('summarizes a long streak at most every ten minutes', async () => {
    isolatedExchanger.BTC.getPendingIncomingTransactions.mockRejectedValue(new Error('node down'));

    await isolated.poll();
    Date.now.mockReturnValue(1_000_000_000_000 + 11 * 60 * 1000);
    await isolated.poll();

    expect(isolatedLog.warn).toHaveBeenCalledTimes(2);
    expect(isolatedLog.warn).toHaveBeenLastCalledWith(expect.stringContaining('still not observed: 2 failed polls'));
  });

  test('says when observation recovers', async () => {
    isolatedExchanger.BTC.getPendingIncomingTransactions.mockRejectedValueOnce(new Error('node down'));
    await isolated.poll();

    isolatedExchanger.BTC.getPendingIncomingTransactions.mockResolvedValue([]);
    await isolated.poll();

    expect(isolatedLog.info).toHaveBeenCalledWith(expect.stringContaining('recovered after 1 failed poll'));
  });
});
