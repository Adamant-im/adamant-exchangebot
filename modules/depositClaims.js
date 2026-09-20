const config = require('./configReader');
const db = require('./DB');
const constants = require('../helpers/const');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const utils = require('../helpers/utils');

const DUPLICATE_KEY_ERROR = 11000;
const EXTERNAL_TXID_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

const CLAIM_STATUS = Object.freeze({
  AWAITING_CLARIFICATION: 'awaiting-clarification',
  ELIGIBLE: 'eligible',
  INELIGIBLE: 'ineligible',
  PENDING: 'pending',
  MANUAL: 'manual',
});

const AUTHORIZATION_STATUS = Object.freeze({
  AUTHORIZED: 'authorized',
  ALREADY_AUTHORIZED: 'already-authorized',
  WAIT: 'wait',
  MANUAL: 'manual',
  CLAIMED: 'claimed',
});

function isDuplicateKey(error) {
  return error?.code === DUPLICATE_KEY_ERROR;
}

function isEvmCoin(coin) {
  return coin === 'ETH' || config.erc20.includes(coin);
}

function getChainScope(coin) {
  if (isEvmCoin(coin)) {
    return 'eip155:1';
  }

  return {
    ADM: 'adamant:mainnet',
    BTC: 'bitcoin:mainnet',
    DASH: 'dash:mainnet',
    DOGE: 'dogecoin:mainnet',
  }[coin];
}

/**
 * Builds the one identifier every payment path uses for an on-chain deposit.
 *
 * ETH and every ERC-20 asset deliberately share the same chain prefix: one EVM
 * transaction hash can move Ether or a token, but it can only fund one exchange.
 *
 * @param {string} coin Incoming ticker
 * @param {string|number} txid Transaction id supplied by the client
 * @returns {string|undefined}
 */
function getDepositKey(coin, txid) {
  const scope = getChainScope(coin);
  const value = String(txid ?? '').trim();

  if (!scope || !value) {
    return undefined;
  }

  if (coin === 'ADM') {
    return `${scope}:${value}`;
  }

  if (!EXTERNAL_TXID_RE.test(value)) {
    return undefined;
  }

  const normalized = value.toLowerCase().replace(/^0x/, '');

  return `${scope}:${normalized}`;
}

function claimDocument({ paymentId, depositKey, senderId, inCurrency, inTxid, date }) {
  return {
    _id: paymentId,
    paymentId,
    depositKey,
    senderId,
    inCurrency,
    inTxid,
    registeredAt: date ?? utils.unix(),
    status: CLAIM_STATUS.PENDING,
  };
}

/**
 * Registers a chat claim without rejecting a competing claim prematurely.
 *
 * `pendingRegistrations` closes the small interval between touching the master
 * deposit record and inserting the claim. A crash in that interval blocks an
 * automatic payout and leaves an operator-visible record instead of creating a
 * window in which an unseen claim could lose the race.
 *
 * @param {object} claim Claim fields
 * @returns {Promise<{depositKey?: string, isLate?: boolean, isNew?: boolean}>}
 */
async function registerClaim(claim) {
  const depositKey = claim.depositKey ?? getDepositKey(claim.inCurrency, claim.inTxid);

  if (!depositKey) {
    return {};
  }

  const now = claim.date ?? utils.unix();

  try {
    const result = await db.depositsDb.db.updateOne(
      { _id: depositKey, reservedBy: null },
      {
        $setOnInsert: {
          chain: depositKey.slice(0, depositKey.lastIndexOf(':')),
          originalTxid: claim.inTxid,
          createdAt: now,
        },
        $set: { lastClaimAt: now },
        $inc: { claimVersion: 1, pendingRegistrations: 1 },
      },
      { upsert: true },
    );

    if (!result.acknowledged || (result.matchedCount === 0 && result.upsertedCount === 0)) {
      return { depositKey, isLate: true };
    }
  } catch (error) {
    if (isDuplicateKey(error)) {
      // A mempool observation may have inserted the master record at the same
      // moment. Retry the conditional increment without upsert; a reserved record
      // still matches nothing and is therefore treated as a late claim.
      const result = await db.depositsDb.db.updateOne(
        { _id: depositKey, reservedBy: null },
        { $set: { lastClaimAt: now }, $inc: { claimVersion: 1, pendingRegistrations: 1 } },
      );

      if (result.modifiedCount !== 1) {
        return { depositKey, isLate: true };
      }
    } else {
      throw error;
    }
  }

  let isNew = false;

  try {
    await db.depositClaimsDb.db.insertOne(claimDocument({ ...claim, depositKey, date: now }));
    isNew = true;
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }
  } finally {
    await db.depositsDb.db.updateOne(
      { _id: depositKey, pendingRegistrations: { $gt: 0 } },
      { $inc: { pendingRegistrations: -1 } },
    );
  }

  return { depositKey, isNew };
}

/**
 * Stores the earliest independently observed appearance of a deposit.
 *
 * The first write wins. In particular, a low-confidence startup snapshot must not
 * later be upgraded to a trustworthy first-seen time: the missing interval is
 * unknowable and therefore requires manual settlement.
 *
 * @param {object} observation Observation fields
 * @returns {Promise<void>}
 */
async function recordObservation({ inCurrency, inTxid, admHeight, reliable, source, observedAt = utils.unix() }) {
  const depositKey = getDepositKey(inCurrency, inTxid);

  if (!depositKey) {
    return;
  }

  try {
    await db.depositsDb.db.updateOne(
      { _id: depositKey, firstSeenSource: { $exists: false } },
      {
        $setOnInsert: {
          chain: depositKey.slice(0, depositKey.lastIndexOf(':')),
          originalTxid: inTxid,
          createdAt: observedAt,
          claimVersion: 0,
          pendingRegistrations: 0,
        },
        $set: {
          firstSeenAt: observedAt,
          firstSeenAdmHeight: admHeight,
          firstSeenReliable: Boolean(reliable),
          firstSeenSource: source,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }

    // Claim registration may have inserted the master document concurrently.
    // A conditional retry records the observation only if no observer won first.
    await db.depositsDb.db.updateOne(
      { _id: depositKey, firstSeenSource: { $exists: false } },
      {
        $set: {
          firstSeenAt: observedAt,
          firstSeenAdmHeight: admHeight,
          firstSeenReliable: Boolean(reliable),
          firstSeenSource: source,
        },
      },
    );
  }

  await db.depositsDb.db.updateOne({ _id: depositKey }, { $set: { lastObservedAt: observedAt } });
}

async function getObservation(depositKey) {
  return db.depositsDb.findOne({ _id: depositKey });
}

async function setClaimStatus(paymentId, status, details = {}) {
  await db.depositClaimsDb.db.updateOne(
    { _id: paymentId },
    { $set: { status, statusUpdatedAt: utils.unix(), ...details } },
  );
}

async function markManual(depositKey, reason) {
  await Promise.all([
    db.depositsDb.db.updateOne(
      { _id: depositKey },
      { $set: { manualReview: true, manualReason: reason, manualAt: utils.unix() } },
    ),
    db.paymentsDb.db.updateMany(
      { depositKey, isFinished: false },
      {
        $set: {
          needHumanCheck: true,
          error: constants.ERRORS.DEPOSIT_CLAIM_CONFLICT,
        },
      },
    ),
  ]);
}

/**
 * Last reason logged for each payment that is waiting, so a payout that waits for a
 * long time is visible in the log without a line on every worker tick.
 *
 * @type {Map<string, string>}
 */
const reportedWaits = new Map();

/**
 * Logs why a payout or refund is waiting — once per payment and reason.
 *
 * @param {object} pay Payment document
 * @param {string} reason Why it waits
 * @param {string} action What waits, for example `payout` or `refund`
 */
function reportWait(pay, reason, action) {
  const key = String(pay._id);

  if (reportedWaits.get(key) === reason) {
    return;
  }

  reportedWaits.set(key, reason);
  log.log(`The ${action} of payment ${pay._id} is waiting: ${reason}.`);
}

/**
 * Forgets the logged waiting reason of a payment that is no longer waiting.
 *
 * @param {object} pay Payment document
 */
function clearWait(pay) {
  reportedWaits.delete(String(pay._id));
}

/**
 * Closes the claim of a request the user abandoned, and hands its deposit to the operator.
 *
 * A request awaiting clarification is dropped when the same user sends a new transfer.
 * Its claim must not stay open — that would block the deposit forever — and it must
 * not simply become ineligible either, because the deposit would then be open to any
 * competing claimant. Manual review keeps the funds safe and visible.
 *
 * @param {object} pay The abandoned payment
 * @param {string} reason Why the claim was abandoned
 * @returns {Promise<void>}
 */
async function abandonClaim(pay, reason) {
  const depositKey = pay.depositKey ?? getDepositKey(pay.inCurrency, pay.inTxid);

  await setClaimStatus(pay._id, CLAIM_STATUS.INELIGIBLE, { reason });

  if (depositKey) {
    await markManual(depositKey, reason);
  }
}

async function markOperatorTopUp(inCurrency, inTxid, admTxId) {
  const depositKey = getDepositKey(inCurrency, inTxid);

  if (!depositKey) {
    return false;
  }

  const topUpFields = {
    operatorTopUp: true,
    operatorTopUpAdmTxId: admTxId,
    manualReview: true,
    manualReason: 'operator-top-up',
  };

  try {
    await db.depositsDb.db.updateOne(
      { _id: depositKey },
      {
        $setOnInsert: {
          chain: depositKey.slice(0, depositKey.lastIndexOf(':')),
          originalTxid: inTxid,
          createdAt: utils.unix(),
          claimVersion: 0,
          pendingRegistrations: 0,
        },
        $set: topUpFields,
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }

    await db.depositsDb.db.updateOne({ _id: depositKey }, { $set: topUpFields });
  }

  await quarantinePayments({ depositKey }, 'operator-top-up');

  return true;
}

/**
 * Atomically reserves a deposit for exactly one payout after the dispute window.
 *
 * @param {object} pay Payment that is ready for payout
 * @param {number} [now] Unix time in milliseconds
 * @returns {Promise<{status: string, reason?: string}>}
 */
async function authorizePayout(pay, now = utils.unix()) {
  const depositKey = pay.depositKey ?? getDepositKey(pay.inCurrency, pay.inTxid);

  if (!depositKey) {
    return { status: AUTHORIZATION_STATUS.MANUAL, reason: 'invalid-deposit-key' };
  }

  const deposit = await db.depositsDb.findOne({ _id: depositKey });

  if (!deposit) {
    return { status: AUTHORIZATION_STATUS.MANUAL, reason: 'missing-deposit-record' };
  }

  if (deposit.reservedBy !== null && deposit.reservedBy !== undefined) {
    return {
      status:
        String(deposit.reservedBy) === String(pay._id)
          ? AUTHORIZATION_STATUS.ALREADY_AUTHORIZED
          : AUTHORIZATION_STATUS.CLAIMED,
      reason: 'deposit-already-reserved',
    };
  }

  if (deposit.manualReview) {
    return { status: AUTHORIZATION_STATUS.MANUAL, reason: deposit.manualReason ?? 'manual-review' };
  }

  if (deposit.pendingRegistrations > 0) {
    // A registration takes milliseconds. A counter that stays raised is left over from
    // a failed write, and waiting on it would block the deposit without anyone knowing.
    if (now - (deposit.lastClaimAt ?? deposit.createdAt ?? now) > constants.DEPOSIT_UNRESOLVED_CLAIM_TIMEOUT) {
      await markManual(depositKey, 'stale-claim-registration');

      return { status: AUTHORIZATION_STATUS.MANUAL, reason: 'stale-claim-registration' };
    }

    return { status: AUTHORIZATION_STATUS.WAIT, reason: 'claim-registration-in-progress' };
  }

  if (pay.inCurrency !== 'ADM') {
    if (!deposit.firstSeenReliable || !deposit.firstSeenAdmHeight) {
      return { status: AUTHORIZATION_STATUS.MANUAL, reason: 'missing-reliable-first-seen' };
    }

    if (now - deposit.firstSeenAt < constants.DEPOSIT_DISPUTE_WINDOW) {
      return { status: AUTHORIZATION_STATUS.WAIT, reason: 'dispute-window' };
    }
  }

  const claims = await db.depositClaimsDb.find({ depositKey }, { sort: { registeredAt: 1, _id: 1 } });
  const unresolved = claims.filter(
    (claim) => claim.status === CLAIM_STATUS.PENDING || claim.status === CLAIM_STATUS.AWAITING_CLARIFICATION,
  );

  if (unresolved.length) {
    // A competing claim is normally validated within minutes. One that stays open far
    // longer — a stalled validation, an abandoned clarification — must not hold the
    // deposit indefinitely, so it is handed to the operator instead.
    const oldestUnresolvedAt = Math.min(...unresolved.map((claim) => claim.registeredAt ?? now));

    if (now - oldestUnresolvedAt > constants.DEPOSIT_UNRESOLVED_CLAIM_TIMEOUT) {
      await markManual(depositKey, 'unresolved-claim-timeout');

      return { status: AUTHORIZATION_STATUS.MANUAL, reason: 'unresolved-claim-timeout' };
    }

    return { status: AUTHORIZATION_STATUS.WAIT, reason: 'unresolved-claim' };
  }

  const eligible = claims.filter((claim) => claim.status === CLAIM_STATUS.ELIGIBLE);
  const eligibleSenders = new Set(eligible.map((claim) => claim.senderId));

  if (eligibleSenders.size !== 1) {
    await markManual(depositKey, eligibleSenders.size ? 'multiple-eligible-senders' : 'no-eligible-claim');

    return {
      status: AUTHORIZATION_STATUS.MANUAL,
      reason: eligibleSenders.size ? 'multiple-eligible-senders' : 'no-eligible-claim',
    };
  }

  const winner = eligible[0];

  if (String(winner.paymentId) !== String(pay._id)) {
    return { status: AUTHORIZATION_STATUS.CLAIMED, reason: 'earlier-eligible-claim' };
  }

  const result = await db.depositsDb.db.updateOne(
    {
      _id: depositKey,
      reservedBy: null,
      manualReview: { $ne: true },
      pendingRegistrations: 0,
      claimVersion: deposit.claimVersion,
    },
    { $set: { reservedBy: pay._id, reservedAt: now } },
  );

  if (result.modifiedCount !== 1) {
    return { status: AUTHORIZATION_STATUS.WAIT, reason: 'deposit-changed-during-authorization' };
  }

  try {
    await db.paymentsDb.db.updateOne(
      { _id: pay._id },
      { $set: { depositKey, depositReserved: true, depositReservedAt: now } },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }

    await markManual(depositKey, 'unique-reservation-conflict');

    return { status: AUTHORIZATION_STATUS.MANUAL, reason: 'unique-reservation-conflict' };
  }

  Object.assign(pay, { depositKey, depositReserved: true, depositReservedAt: now });

  return { status: AUTHORIZATION_STATUS.AUTHORIZED };
}

async function quarantinePayments(filter, reason) {
  const result = await db.paymentsDb.db.updateMany(
    { ...filter, isFinished: false, outTxid: null },
    {
      $set: {
        needHumanCheck: true,
        error: constants.ERRORS.DEPOSIT_CLAIM_CONFLICT,
        depositAuditStatus: reason,
      },
    },
  );

  return result.modifiedCount;
}

/** Version of the one-time backfill that migrated pre-claims payments. */
const BACKFILL_VERSION = 1;

/**
 * Prepares deposit claims before any worker starts.
 *
 * Every start resets leftover registration counters: no registration can be in flight
 * yet, so a raised counter is left over from a crash or a failed write.
 *
 * The first start after the upgrade also backfills canonical keys and claims for
 * existing payments — once. Later starts audit only unfinished payments, because
 * re-deriving the status of settled claims on every restart would overwrite decisions
 * the validator already made, for example turning a manual claim back into an
 * eligible one.
 *
 * @returns {Promise<void>}
 */
async function initialize() {
  const reset = await db.depositsDb.db.updateMany(
    { pendingRegistrations: { $gt: 0 } },
    { $set: { pendingRegistrations: 0 } },
  );

  if (reset.modifiedCount) {
    log.warn(
      `Reset the claim registration counter of ${reset.modifiedCount} deposit(s) left over from a previous run.`,
    );
  }

  const system = await db.systemDb.findOne();
  const isBackfilled = system?.depositClaimsBackfillVersion === BACKFILL_VERSION;

  const quarantined = isBackfilled ? await auditUnfinishedPayments() : await backfillPayments();

  await db.paymentsDb.db.createIndex(
    { depositKey: 1 },
    {
      name: 'unique_reserved_deposit',
      unique: true,
      partialFilterExpression: { depositReserved: true },
    },
  );

  if (!isBackfilled) {
    await db.systemDb.db.updateOne(
      {},
      { $set: { depositClaimsBackfillVersion: BACKFILL_VERSION, depositClaimsBackfilledAt: utils.unix() } },
      { upsert: true },
    );
  }

  if (quarantined) {
    notify(
      `${config.notifyName} quarantined ${quarantined} existing payment(s) while preparing deposit claims. Review them before manual settlement.`,
      'warn',
    );
  }
}

/**
 * Quarantines unfinished payments whose deposit key cannot be built.
 *
 * @returns {Promise<number>} How many payments were quarantined
 */
async function auditUnfinishedPayments() {
  const payments = await db.paymentsDb.find({ isFinished: false, inTxid: { $exists: true } });
  let quarantined = 0;

  for (const pay of payments) {
    if (!getDepositKey(pay.inCurrency, pay.inTxid)) {
      quarantined += await quarantinePayments({ _id: pay._id }, 'invalid-deposit-key');
    }
  }

  log.log(`Deposit claims are ready; audited ${payments.length} unfinished payment(s).`);

  return quarantined;
}

/**
 * Backfills canonical keys and claims for every payment stored before claims existed.
 *
 * Existing duplicate deposits and external in-flight payments without trustworthy
 * first-seen evidence are quarantined. A deposit that has already moved funds — paid
 * out or refunded — is reserved for its payment, so it can never be claimed again.
 * Historical records are kept for audit and never reopened.
 *
 * @returns {Promise<number>} How many payments were quarantined
 */
async function backfillPayments() {
  const payments = await db.paymentsDb.find({ inTxid: { $exists: true }, inCurrency: { $exists: true } });
  let invalid = 0;
  const legacyByDeposit = new Map();
  const legacyExternalPayments = [];

  for (const pay of payments) {
    const depositKey = getDepositKey(pay.inCurrency, pay.inTxid);
    const isLegacy = pay.depositClaimVersion !== 1;

    if (!depositKey) {
      invalid += await quarantinePayments({ _id: pay._id }, 'invalid-deposit-key');
      continue;
    }

    if (isLegacy) {
      const group = legacyByDeposit.get(depositKey) ?? [];

      group.push(pay._id);
      legacyByDeposit.set(depositKey, group);

      if (pay.inCurrency !== 'ADM' && !pay.isFinished && !pay.outTxid) {
        legacyExternalPayments.push(pay._id);
      }
    }

    if (pay.depositKey !== depositKey || isLegacy) {
      await db.paymentsDb.db.updateOne({ _id: pay._id }, { $set: { depositKey, depositClaimVersion: 1 } });
    }

    await registerClaim({
      paymentId: pay._id,
      depositKey,
      senderId: pay.senderId,
      inCurrency: pay.inCurrency,
      inTxid: pay.inTxid,
      date: pay.date,
    });

    if (pay.transactionIsValid === true) {
      await setClaimStatus(pay._id, CLAIM_STATUS.ELIGIBLE, { migrated: true });
    } else if (pay.transactionIsValid === false || pay.isFinished) {
      await setClaimStatus(pay._id, CLAIM_STATUS.INELIGIBLE, { migrated: true });
    }

    if (pay.outTxid || pay.sentBackTx) {
      // Funds already left the bot for this deposit. The payment predates the claim
      // system, so nothing else marks the deposit as spent.
      await db.depositsDb.db.updateOne(
        { _id: depositKey, reservedBy: null },
        { $set: { reservedBy: pay._id, reservedAt: utils.unix(), reservedByBackfill: true } },
      );
    }
  }

  let quarantined = invalid;

  for (const [depositKey, paymentIds] of legacyByDeposit) {
    if (paymentIds.length < 2) {
      continue;
    }

    quarantined += await quarantinePayments({ _id: { $in: paymentIds } }, 'duplicate-deposit-key');
    await db.depositsDb.db.updateOne(
      { _id: depositKey },
      { $set: { manualReview: true, manualReason: 'duplicate-existing-payments' } },
    );
  }

  if (legacyExternalPayments.length) {
    quarantined += await quarantinePayments(
      { _id: { $in: legacyExternalPayments }, depositReserved: { $ne: true } },
      'missing-first-seen-after-upgrade',
    );
  }

  log.log(`Canonical deposit claims are ready; backfilled ${payments.length} existing payment(s).`);

  return quarantined;
}

module.exports = {
  AUTHORIZATION_STATUS,
  CLAIM_STATUS,
  abandonClaim,
  authorizePayout,
  clearWait,
  reportWait,
  getDepositKey,
  getObservation,
  initialize,
  isEvmCoin,
  markManual,
  markOperatorTopUp,
  recordObservation,
  registerClaim,
  setClaimStatus,
};
