jest.mock('../../modules/DB', () => ({
  systemDb: { findOne: jest.fn(), db: { updateOne: jest.fn() } },
  depositsDb: { findOne: jest.fn(), db: { updateOne: jest.fn(), updateMany: jest.fn() } },
  depositClaimsDb: { find: jest.fn(), db: { insertOne: jest.fn(), updateOne: jest.fn() } },
  paymentsDb: {
    find: jest.fn(),
    db: {
      aggregate: jest.fn(),
      createIndex: jest.fn(),
      updateMany: jest.fn(),
      updateOne: jest.fn(),
    },
  },
}));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../helpers/log', () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../../modules/DB');
const depositClaims = require('../../modules/depositClaims');

const HASH = `0x${'A1'.repeat(32)}`;
const DEPOSIT_KEY = `eip155:1:${'a1'.repeat(32)}`;

beforeEach(() => {
  db.systemDb.findOne.mockReset().mockResolvedValue(null);
  db.systemDb.db.updateOne.mockReset().mockResolvedValue({ acknowledged: true });
  db.depositsDb.db.updateMany.mockReset().mockResolvedValue({ modifiedCount: 0 });
  db.depositsDb.db.updateOne.mockReset().mockResolvedValue({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
  db.depositsDb.findOne.mockReset();
  db.depositClaimsDb.find.mockReset();
  db.depositClaimsDb.db.insertOne.mockReset().mockResolvedValue({ insertedId: 'payment-1' });
  db.depositClaimsDb.db.updateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
  db.paymentsDb.db.updateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
  db.paymentsDb.db.updateMany.mockReset().mockResolvedValue({ modifiedCount: 0 });
  db.paymentsDb.find.mockReset().mockResolvedValue([]);
  db.paymentsDb.db.createIndex.mockReset().mockResolvedValue('unique_reserved_deposit');
});

describe('depositClaims.initialize', () => {
  test('backfills only legacy in-flight payments into the upgrade quarantine', async () => {
    const legacyHash = '11'.repeat(32);
    const currentHash = '22'.repeat(32);

    db.paymentsDb.find.mockResolvedValue([
      {
        _id: 'legacy-payment',
        senderId: 'U1',
        inCurrency: 'BTC',
        inTxid: legacyHash,
        isFinished: false,
      },
      {
        _id: 'current-payment',
        senderId: 'U2',
        inCurrency: 'BTC',
        inTxid: currentHash,
        depositClaimVersion: 1,
        depositKey: `bitcoin:mainnet:${currentHash}`,
        isFinished: false,
      },
    ]);

    await depositClaims.initialize();

    expect(db.paymentsDb.db.updateMany).toHaveBeenCalledWith(
      {
        _id: { $in: ['legacy-payment'] },
        depositReserved: { $ne: true },
        isFinished: false,
        outTxid: null,
      },
      expect.objectContaining({
        $set: expect.objectContaining({ depositAuditStatus: 'missing-first-seen-after-upgrade' }),
      }),
    );
    expect(db.paymentsDb.db.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: ['current-payment'] } }),
      expect.anything(),
    );
    expect(db.paymentsDb.db.createIndex).toHaveBeenCalledWith(
      { depositKey: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { depositReserved: true } }),
    );
  });
});

describe('depositClaims.getDepositKey', () => {
  test('normalizes EVM hash case and shares the key across ETH and ERC-20 assets', () => {
    expect(depositClaims.getDepositKey('ETH', HASH)).toBe(DEPOSIT_KEY);
    expect(depositClaims.getDepositKey('USDT', HASH.toLowerCase())).toBe(DEPOSIT_KEY);
    expect(depositClaims.getDepositKey('USDC', HASH.slice(2))).toBe(DEPOSIT_KEY);
  });

  test('keeps UTXO chains separate even when transaction hashes are equal', () => {
    const hash = 'ab'.repeat(32);

    expect(depositClaims.getDepositKey('BTC', hash)).toBe(`bitcoin:mainnet:${hash}`);
    expect(depositClaims.getDepositKey('DASH', hash)).toBe(`dash:mainnet:${hash}`);
    expect(depositClaims.getDepositKey('DOGE', hash)).toBe(`dogecoin:mainnet:${hash}`);
  });

  test('rejects malformed external transaction identifiers', () => {
    expect(depositClaims.getDepositKey('ETH', '0xabc')).toBeUndefined();
    expect(depositClaims.getDepositKey('BTC', 'not-a-transaction')).toBeUndefined();
  });
});

describe('depositClaims.registerClaim', () => {
  test('uses an atomic upsert and inserts a claim without a find-then-save race', async () => {
    const result = await depositClaims.registerClaim({
      paymentId: 'payment-1',
      senderId: 'U1',
      inCurrency: 'ETH',
      inTxid: HASH,
    });

    expect(result).toMatchObject({ depositKey: DEPOSIT_KEY, isNew: true });
    expect(db.depositsDb.db.updateOne).toHaveBeenNthCalledWith(
      1,
      { _id: DEPOSIT_KEY, reservedBy: null },
      expect.objectContaining({ $inc: { claimVersion: 1, pendingRegistrations: 1 } }),
      { upsert: true },
    );
    expect(db.depositClaimsDb.db.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'payment-1', depositKey: DEPOSIT_KEY, senderId: 'U1' }),
    );
    expect(db.depositsDb.db.updateOne).toHaveBeenLastCalledWith(
      { _id: DEPOSIT_KEY, pendingRegistrations: { $gt: 0 } },
      { $inc: { pendingRegistrations: -1 } },
    );
  });

  test('treats a duplicate-key upsert as a claim arriving after reservation', async () => {
    db.depositsDb.db.updateOne
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }))
      .mockResolvedValueOnce({ modifiedCount: 0 });

    await expect(
      depositClaims.registerClaim({ paymentId: 'payment-2', senderId: 'U2', inCurrency: 'ETH', inTxid: HASH }),
    ).resolves.toMatchObject({ depositKey: DEPOSIT_KEY, isLate: true });
    expect(db.depositClaimsDb.db.insertOne).not.toHaveBeenCalled();
  });

  test('retries atomically when first-seen observation created the master record concurrently', async () => {
    db.depositsDb.db.updateOne
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }))
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 1 });

    await expect(
      depositClaims.registerClaim({ paymentId: 'payment-2', senderId: 'U2', inCurrency: 'ETH', inTxid: HASH }),
    ).resolves.toMatchObject({ depositKey: DEPOSIT_KEY, isNew: true });
    expect(db.depositClaimsDb.db.insertOne).toHaveBeenCalled();
  });
});

describe('depositClaims.recordObservation', () => {
  test('writes the first-seen evidence in one atomic first-writer-wins update', async () => {
    await depositClaims.recordObservation({
      inCurrency: 'ETH',
      inTxid: HASH,
      admHeight: 500,
      reliable: true,
      source: 'eth-mempool',
      observedAt: 123456,
    });

    expect(db.depositsDb.db.updateOne).toHaveBeenNthCalledWith(
      1,
      { _id: DEPOSIT_KEY, firstSeenSource: { $exists: false } },
      expect.objectContaining({
        $set: {
          firstSeenAdmHeight: 500,
          firstSeenAt: 123456,
          firstSeenReliable: true,
          firstSeenSource: 'eth-mempool',
        },
      }),
      { upsert: true },
    );
    expect(db.depositsDb.db.updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: DEPOSIT_KEY },
      { $set: { lastObservedAt: 123456 } },
    );
  });
});

describe('depositClaims.authorizePayout', () => {
  const payment = {
    _id: 'payment-1',
    senderId: 'U1',
    inCurrency: 'ETH',
    inTxid: HASH,
    depositKey: DEPOSIT_KEY,
  };

  function readyDeposit(overrides = {}) {
    return {
      _id: DEPOSIT_KEY,
      claimVersion: 2,
      pendingRegistrations: 0,
      firstSeenReliable: true,
      firstSeenAdmHeight: 100,
      firstSeenAt: 1,
      ...overrides,
    };
  }

  test('reserves the winner with the observed claim version', async () => {
    db.depositsDb.findOne.mockResolvedValue(readyDeposit());
    db.depositClaimsDb.find.mockResolvedValue([
      { _id: 'payment-1', paymentId: 'payment-1', senderId: 'U1', status: 'eligible', registeredAt: 1 },
    ]);

    await expect(depositClaims.authorizePayout({ ...payment }, 1_000_000)).resolves.toEqual({
      status: 'authorized',
    });
    expect(db.depositsDb.db.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: DEPOSIT_KEY, claimVersion: 2, pendingRegistrations: 0 }),
      { $set: { reservedBy: 'payment-1', reservedAt: 1_000_000 } },
    );
    expect(db.paymentsDb.db.updateOne).toHaveBeenCalledWith(
      { _id: 'payment-1' },
      { $set: expect.objectContaining({ depositKey: DEPOSIT_KEY, depositReserved: true }) },
    );
  });

  test('allows only one of two concurrent authorization attempts to win', async () => {
    db.depositsDb.findOne.mockResolvedValue(readyDeposit());
    db.depositClaimsDb.find.mockResolvedValue([
      { _id: 'payment-1', paymentId: 'payment-1', senderId: 'U1', status: 'eligible', registeredAt: 1 },
    ]);

    let won = false;
    db.depositsDb.db.updateOne.mockImplementation(async (filter) => {
      if (!Object.hasOwn(filter, 'claimVersion')) {
        return { modifiedCount: 0 };
      }

      if (won) {
        return { modifiedCount: 0 };
      }

      won = true;

      return { modifiedCount: 1 };
    });

    const results = await Promise.all([
      depositClaims.authorizePayout({ ...payment }, 1_000_000),
      depositClaims.authorizePayout({ ...payment }, 1_000_000),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['authorized', 'wait']);
    expect(db.paymentsDb.db.updateOne).toHaveBeenCalledTimes(1);
  });

  test('quarantines two eligible ADAMANT accounts claiming the same deposit', async () => {
    db.depositsDb.findOne.mockResolvedValue(readyDeposit());
    db.depositClaimsDb.find.mockResolvedValue([
      { paymentId: 'payment-1', senderId: 'U1', status: 'eligible', registeredAt: 1 },
      { paymentId: 'payment-2', senderId: 'U2', status: 'eligible', registeredAt: 2 },
    ]);

    await expect(depositClaims.authorizePayout({ ...payment }, 1_000_000)).resolves.toMatchObject({
      status: 'manual',
      reason: 'multiple-eligible-senders',
    });
    expect(db.paymentsDb.db.updateMany).toHaveBeenCalledWith(
      { depositKey: DEPOSIT_KEY, isFinished: false },
      expect.objectContaining({ $set: expect.objectContaining({ needHumanCheck: true }) }),
    );
  });

  test('requires manual settlement when first-seen evidence is missing', async () => {
    db.depositsDb.findOne.mockResolvedValue(readyDeposit({ firstSeenReliable: false }));

    await expect(depositClaims.authorizePayout({ ...payment }, 1_000_000)).resolves.toMatchObject({
      status: 'manual',
      reason: 'missing-reliable-first-seen',
    });
    expect(db.depositsDb.db.updateOne).not.toHaveBeenCalled();
  });

  test('refuses to authorize a payout-ready payment whose legacy incoming coin has no canonical deposit key', async () => {
    await expect(
      depositClaims.authorizePayout({
        _id: 'payment-lsk',
        senderId: 'U1',
        inCurrency: 'LSK',
        inTxid: 'ab'.repeat(32),
      }),
    ).resolves.toEqual({ status: 'manual', reason: 'invalid-deposit-key' });

    expect(db.depositsDb.findOne).not.toHaveBeenCalled();
  });

  test('blocks authorization while a competing claim is awaiting clarification', async () => {
    db.depositsDb.findOne.mockResolvedValue(readyDeposit());
    db.depositClaimsDb.find.mockResolvedValue([
      { paymentId: 'payment-1', senderId: 'U1', status: 'eligible', registeredAt: 1 },
      { paymentId: 'payment-2', senderId: 'U2', status: 'awaiting-clarification', registeredAt: 2 },
    ]);

    await expect(depositClaims.authorizePayout({ ...payment }, 1_000_000)).resolves.toMatchObject({
      status: 'wait',
      reason: 'unresolved-claim',
    });

    expect(db.depositsDb.db.updateOne).not.toHaveBeenCalled();
  });
});

describe('depositClaims.initialize — every start', () => {
  test('resets registration counters left over from a previous run before any worker starts', async () => {
    db.depositsDb.db.updateMany.mockResolvedValue({ modifiedCount: 2 });

    await depositClaims.initialize();

    expect(db.depositsDb.db.updateMany).toHaveBeenCalledWith(
      { pendingRegistrations: { $gt: 0 } },
      { $set: { pendingRegistrations: 0 } },
    );
  });

  test('backfills once, then records that it has', async () => {
    await depositClaims.initialize();

    expect(db.paymentsDb.find).toHaveBeenCalledWith({ inTxid: { $exists: true }, inCurrency: { $exists: true } });
    expect(db.systemDb.db.updateOne).toHaveBeenCalledWith(
      {},
      { $set: expect.objectContaining({ depositClaimsBackfillVersion: 1 }) },
      { upsert: true },
    );
  });

  test('after the backfill, audits only unfinished payments and leaves settled claims alone', async () => {
    db.systemDb.findOne.mockResolvedValue({ depositClaimsBackfillVersion: 1 });
    db.paymentsDb.find.mockResolvedValue([
      {
        _id: 'manual-payment',
        senderId: 'U1',
        inCurrency: 'BTC',
        inTxid: '11'.repeat(32),
        depositKey: `bitcoin:mainnet:${'11'.repeat(32)}`,
        depositClaimVersion: 1,
        transactionIsValid: true,
        needHumanCheck: true,
        isFinished: false,
      },
    ]);

    await depositClaims.initialize();

    expect(db.paymentsDb.find).toHaveBeenCalledWith({ isFinished: false, inTxid: { $exists: true } });
    // Re-deriving statuses on every restart would turn this manual claim back into an
    // eligible one.
    expect(db.depositClaimsDb.db.updateOne).not.toHaveBeenCalled();
    expect(db.depositClaimsDb.db.insertOne).not.toHaveBeenCalled();
    expect(db.systemDb.db.updateOne).not.toHaveBeenCalled();
  });

  test('reserves a deposit that already moved funds before the upgrade, so it cannot be claimed again', async () => {
    const hash = '33'.repeat(32);

    db.paymentsDb.find.mockResolvedValue([
      {
        _id: 'paid-payment',
        senderId: 'U1',
        inCurrency: 'ADM',
        inTxid: 'adm-tx-9',
        outTxid: 'payout-hash',
        transactionIsValid: true,
        isFinished: true,
      },
      {
        _id: 'refunded-payment',
        senderId: 'U2',
        inCurrency: 'BTC',
        inTxid: hash,
        sentBackTx: 'refund-hash',
        transactionIsValid: true,
        isFinished: true,
      },
    ]);

    await depositClaims.initialize();

    expect(db.depositsDb.db.updateOne).toHaveBeenCalledWith(
      { _id: 'adamant:mainnet:adm-tx-9', reservedBy: null },
      { $set: expect.objectContaining({ reservedBy: 'paid-payment', reservedByBackfill: true }) },
    );
    expect(db.depositsDb.db.updateOne).toHaveBeenCalledWith(
      { _id: `bitcoin:mainnet:${hash}`, reservedBy: null },
      { $set: expect.objectContaining({ reservedBy: 'refunded-payment', reservedByBackfill: true }) },
    );
  });
});

describe('depositClaims.authorizePayout — bounded waits', () => {
  const payment = { _id: 'payment-1', senderId: 'U1', inCurrency: 'ETH', inTxid: HASH, depositKey: DEPOSIT_KEY };
  const now = 10 * 60 * 60 * 1000;

  test('hands the deposit to the operator once a competing claim has stayed unresolved too long', async () => {
    db.depositsDb.findOne.mockResolvedValue({
      _id: DEPOSIT_KEY,
      claimVersion: 2,
      pendingRegistrations: 0,
      firstSeenReliable: true,
      firstSeenAdmHeight: 100,
      firstSeenAt: 1,
    });
    db.depositClaimsDb.find.mockResolvedValue([
      { paymentId: 'payment-1', senderId: 'U1', status: 'eligible', registeredAt: now - 2 * 60 * 60 * 1000 },
      { paymentId: 'payment-2', senderId: 'U2', status: 'pending', registeredAt: now - 2 * 60 * 60 * 1000 },
    ]);

    await expect(depositClaims.authorizePayout({ ...payment }, now)).resolves.toEqual({
      status: 'manual',
      reason: 'unresolved-claim-timeout',
    });
    expect(db.depositsDb.db.updateOne).toHaveBeenCalledWith(
      { _id: DEPOSIT_KEY },
      { $set: expect.objectContaining({ manualReview: true, manualReason: 'unresolved-claim-timeout' }) },
    );
  });

  test('waits, without escalating, while a competing claim is fresh', async () => {
    db.depositsDb.findOne.mockResolvedValue({
      _id: DEPOSIT_KEY,
      claimVersion: 2,
      pendingRegistrations: 0,
      firstSeenReliable: true,
      firstSeenAdmHeight: 100,
      firstSeenAt: 1,
    });
    db.depositClaimsDb.find.mockResolvedValue([
      { paymentId: 'payment-2', senderId: 'U2', status: 'pending', registeredAt: now - 60 * 1000 },
    ]);

    await expect(depositClaims.authorizePayout({ ...payment }, now)).resolves.toEqual({
      status: 'wait',
      reason: 'unresolved-claim',
    });
    expect(db.depositsDb.db.updateOne).not.toHaveBeenCalled();
  });

  test('hands the deposit to the operator when a registration counter stays raised', async () => {
    db.depositsDb.findOne.mockResolvedValue({
      _id: DEPOSIT_KEY,
      claimVersion: 2,
      pendingRegistrations: 1,
      lastClaimAt: now - 2 * 60 * 60 * 1000,
    });

    await expect(depositClaims.authorizePayout({ ...payment }, now)).resolves.toEqual({
      status: 'manual',
      reason: 'stale-claim-registration',
    });
  });
});

describe('depositClaims.abandonClaim', () => {
  test('closes the claim and hands the deposit to the operator', async () => {
    await depositClaims.abandonClaim(
      { _id: 'old-payment', inCurrency: 'ETH', inTxid: HASH, depositKey: DEPOSIT_KEY },
      'abandoned-clarification',
    );

    expect(db.depositClaimsDb.db.updateOne).toHaveBeenCalledWith(
      { _id: 'old-payment' },
      { $set: expect.objectContaining({ status: 'ineligible', reason: 'abandoned-clarification' }) },
    );
    // Only ineligible, the deposit would be open to any competing claimant.
    expect(db.depositsDb.db.updateOne).toHaveBeenCalledWith(
      { _id: DEPOSIT_KEY },
      { $set: expect.objectContaining({ manualReview: true, manualReason: 'abandoned-clarification' }) },
    );
  });
});

describe('depositClaims.reportWait', () => {
  test('logs a waiting reason once per payment, and again when the reason changes', () => {
    const log = require('../../helpers/log');
    const pay = { _id: 'waiting-payment' };

    depositClaims.reportWait(pay, 'dispute-window', 'payout');
    depositClaims.reportWait(pay, 'dispute-window', 'payout');
    depositClaims.reportWait(pay, 'unresolved-claim', 'payout');
    depositClaims.clearWait(pay);
    depositClaims.reportWait(pay, 'unresolved-claim', 'payout');

    const lines = log.log.mock.calls.filter(([line]) => line.includes('waiting-payment'));

    expect(lines).toHaveLength(3);
  });
});
