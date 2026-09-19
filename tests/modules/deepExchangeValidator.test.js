jest.mock('../../modules/DB', () => ({ paymentsDb: { find: jest.fn() } }));
jest.mock('../../modules/api', () => ({ getTransaction: jest.fn() }));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../helpers/messenger', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../modules/depositClaims', () => ({
  CLAIM_STATUS: { ELIGIBLE: 'eligible', INELIGIBLE: 'ineligible', MANUAL: 'manual' },
  getObservation: jest.fn(),
  isEvmCoin: jest.fn((coin) => coin === 'ETH' || coin === 'USDT'),
  markManual: jest.fn().mockResolvedValue(undefined),
  recordObservation: jest.fn().mockResolvedValue(undefined),
  setClaimStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../helpers/cryptos/exchanger', () => ({
  getKvsCryptoAddress: jest.fn(),
  getKvsCryptoAddressRecord: jest.fn(),
  ADM: {
    getTransaction: jest.fn(),
    account: { address: 'U14172822264918400879' },
    isValidAddress: (address) => /^U[0-9]{6,}$/.test(address),
  },
  BTC: {
    getTransaction: jest.fn(),
    account: { address: '1ETWHRzkiNTEbQB6GGFCG75eVTPCV2AFR3' },
    isValidAddress: (address) => /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address),
  },
  ETH: {
    getTransaction: jest.fn(),
    account: { address: '0x1417282226491840087900000000000000000000' },
    isValidAddress: (address) => /^0x[0-9a-fA-F]{40}$/.test(address),
    getErc20token: jest.fn((contract) => {
      if (String(contract).toLowerCase() === '0xdac17f958d2ee523a2206206994597c13d831ec7') {
        return { token: 'USDT' };
      }

      return undefined;
    }),
  },
  USDT: {
    getTransaction: jest.fn(),
    account: { address: '0x1417282226491840087900000000000000000000' },
    isValidAddress: (address) => /^0x[0-9a-fA-F]{40}$/.test(address),
    model: { sc: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
  },
}));
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const db = require('../../modules/DB');
const api = require('../../modules/api');
const notify = require('../../helpers/notify');
const messenger = require('../../helpers/messenger');
const exchangerUtils = require('../../helpers/cryptos/exchanger');
const log = require('../../helpers/log');
const constants = require('../../helpers/const');
const config = require('../../modules/configReader');
const utils = require('../../helpers/utils');
const validator = require('../../modules/deepExchangeValidator');
const depositClaims = require('../../modules/depositClaims');
const { createPayment } = require('../fixtures/payment');

const USER = 'U16655734187932477074';
const BOT_ADM = 'U14172822264918400879';
/** The in-chat message timestamp, in ADAMANT epoch seconds. */
const ADM_TIMESTAMP = 284777920;

/**
 * Builds the ADAMANT transaction that carried the exchange request.
 *
 * @returns {object}
 */
function admTx() {
  return { id: 'adm-tx-1', senderId: USER, timestamp: ADM_TIMESTAMP };
}

/**
 * Builds an on-chain transfer that matches the payment being validated.
 *
 * @param {object} [overrides] Fields to change
 * @returns {object}
 */
function incomingTx(overrides = {}) {
  return {
    senderId: USER,
    recipientId: BOT_ADM,
    amount: 100,
    fee: 0.5,
    status: true,
    height: 1000,
    timestamp: utils.toTimestamp(ADM_TIMESTAMP),
    confirmations: 3,
    ...overrides,
  };
}

beforeEach(() => {
  exchangerUtils.getKvsCryptoAddress.mockResolvedValue('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2');
  exchangerUtils.getKvsCryptoAddressRecord.mockResolvedValue({
    address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
    height: 90,
    transactionId: 'kvs-tx-1',
  });
  depositClaims.getObservation.mockResolvedValue({
    firstSeenSource: 'btc-mempool',
    firstSeenReliable: true,
    firstSeenAdmHeight: 100,
    firstSeenAt: Date.now() - 600000,
  });
  exchangerUtils.ADM.getTransaction.mockResolvedValue(incomingTx());
  exchangerUtils.ETH.getTransaction.mockResolvedValue(incomingTx());
  exchangerUtils.USDT.getTransaction.mockResolvedValue(incomingTx());
});

describe('deepExchangeValidator.validate', () => {
  test('accepts a transfer whose sender, recipient, amount and timestamp all match', async () => {
    const pay = createPayment({ transactionIsValid: null, senderKvsInAddress: undefined });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(true);
    expect(pay.inAmountReal).toBe(100);
    expect(pay.isFinished).toBe(false);
  });

  test('knows the user’s ADM address without asking the KVS', async () => {
    const pay = createPayment({ transactionIsValid: null, senderKvsInAddress: undefined, outCurrency: 'ADM' });

    await validator.validate(pay, admTx());

    expect(pay.senderKvsInAddress).toBe(USER);
    expect(exchangerUtils.getKvsCryptoAddress).not.toHaveBeenCalled();
  });

  test('waits for the next tick when the KVS cannot be read', async () => {
    exchangerUtils.getKvsCryptoAddressRecord.mockResolvedValue(undefined);

    const pay = createPayment({ transactionIsValid: null, senderKvsInAddress: undefined, inCurrency: 'BTC' });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBeNull();
    expect(pay.isFinished).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to fetch the BTC address'));
  });

  test('quarantines a payment whose incoming coin adapter no longer exists', async () => {
    const pay = createPayment({ transactionIsValid: null, inCurrency: 'LSK' });

    await validator.validate(pay, admTx());

    expect(pay.needHumanCheck).toBe(true);
    expect(pay.isFinished).toBe(true);
    expect(pay.error).toBe(constants.ERRORS.UNSUPPORTED_COIN);
    expect(exchangerUtils.getKvsCryptoAddress).not.toHaveBeenCalled();
  });

  test('escalates when the user has published no address for the coin they sent', async () => {
    exchangerUtils.getKvsCryptoAddressRecord.mockResolvedValue('none');

    const pay = createPayment({ transactionIsValid: null, senderKvsInAddress: undefined, inCurrency: 'BTC' });

    await validator.validate(pay, admTx());

    expect(pay.error).toBe(constants.ERRORS.NO_IN_KVS_ADDRESS);
    expect(pay.needHumanCheck).toBe(true);
    expect(pay.isFinished).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('cannot fetch the _BTC_ address'), 'error');
  });

  test('refunds when the user has published no payout address', async () => {
    exchangerUtils.getKvsCryptoAddress.mockImplementation(async (coin) => (coin === 'BTC' ? 'none' : USER));

    const pay = createPayment({
      transactionIsValid: null,
      inCurrency: 'ADM',
      outCurrency: 'BTC',
      senderKvsInAddress: undefined,
      senderKvsOutAddress: undefined,
    });

    await validator.validate(pay, admTx());

    expect(pay.needToSendBack).toBe(true);
    expect(pay.error).toBe(constants.ERRORS.NO_OUT_KVS_ADDRESS);
    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('ADAMANT KVS'));
  });

  test('refunds rather than paying out to a malformed payout address', async () => {
    exchangerUtils.getKvsCryptoAddress.mockResolvedValue('definitely-not-an-address');

    const pay = createPayment({
      transactionIsValid: null,
      inCurrency: 'ADM',
      outCurrency: 'BTC',
      senderKvsInAddress: undefined,
      senderKvsOutAddress: undefined,
    });

    await validator.validate(pay, admTx());

    expect(pay.needToSendBack).toBe(true);
    expect(pay.error).toBe(constants.ERRORS.INVALID_PAYOUT_ADDRESS);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('invalid _BTC_ payout address'), 'warn');
  });

  test('retries while the transfer is not visible on-chain yet', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(null);

    const pay = createPayment({ transactionIsValid: null, counterTxDeepValidator: 3 });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBeNull();
    expect(pay.isFinished).toBe(false);
    expect(pay.counterTxDeepValidator).toBe(4);
  });

  test('declines a transfer that never appears, once the retries are exhausted', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(null);

    const pay = createPayment({
      transactionIsValid: null,
      counterTxDeepValidator: constants.VALIDATOR_GET_TX_RETRIES,
    });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(false);
    expect(pay.isFinished).toBe(true);
    expect(pay.error).toBe(constants.ERRORS.UNABLE_TO_FETCH_TX);
  });

  test('waits for the next tick when the transfer details are incomplete', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(incomingTx({ senderId: undefined }));

    const pay = createPayment({ transactionIsValid: null });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to get the full details'));
  });

  test('rejects a transfer sent from an address the user did not publish', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(incomingTx({ senderId: 'U9999999999999999999' }));

    const pay = createPayment({ transactionIsValid: null });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(false);
    expect(pay.error).toBe(constants.ERRORS.WRONG_SENDER);
    expect(pay.isFinished).toBe(true);
  });

  test('rejects a transfer that was not sent to the bot', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(incomingTx({ recipientId: 'U9999999999999999999' }));

    const pay = createPayment({ transactionIsValid: null });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(false);
    expect(pay.error).toBe(constants.ERRORS.WRONG_RECIPIENT);
  });

  test('rejects an ERC-20 transfer announced as ETH', async () => {
    exchangerUtils.ETH.getTransaction.mockResolvedValue(
      incomingTx({
        senderId: '0x1111111111111111111111111111111111111111',
        recipientId: '0x1417282226491840087900000000000000000000',
        amount: 100,
        contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      }),
    );
    exchangerUtils.getKvsCryptoAddressRecord.mockResolvedValue({
      address: '0x1111111111111111111111111111111111111111',
      height: 90,
      transactionId: 'kvs-tx-2',
    });

    const pay = createPayment({
      transactionIsValid: null,
      inCurrency: 'ETH',
      outCurrency: 'BTC',
      inAmountMessage: 100,
      senderKvsInAddress: undefined,
    });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(false);
    expect(pay.error).toBe(constants.ERRORS.WRONG_ASSET);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('wrong asset'), 'error');
  });

  test('rejects a copied address that was written to KVS after the deposit first appeared', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const sender = '0x1111111111111111111111111111111111111111';

    exchangerUtils.ETH.getTransaction.mockResolvedValue(
      incomingTx({
        senderId: sender,
        recipientId: '0x1417282226491840087900000000000000000000',
        amount: 100,
      }),
    );
    exchangerUtils.getKvsCryptoAddressRecord.mockResolvedValue({
      address: sender,
      height: 99,
      transactionId: 'late-kvs-tx',
    });
    depositClaims.getObservation.mockResolvedValue({
      firstSeenSource: 'eth-mempool',
      firstSeenReliable: true,
      firstSeenAdmHeight: 100,
      firstSeenAt: Date.now() - 600000,
    });

    const pay = createPayment({
      transactionIsValid: null,
      inCurrency: 'ETH',
      outCurrency: 'ADM',
      inTxid: hash,
      depositKey: `eip155:1:${hash.slice(2)}`,
      senderKvsInAddress: undefined,
      senderKvsOutAddress: USER,
    });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(false);
    expect(pay.isFinished).toBe(true);
    expect(pay.depositOwnershipStatus).toBe('late-kvs-binding');
    expect(depositClaims.setClaimStatus).toHaveBeenCalledWith(
      pay._id,
      'ineligible',
      expect.objectContaining({ reason: `validation-error-${constants.ERRORS.UNVERIFIED_DEPOSIT_OWNER}` }),
    );
  });

  test('requires manual settlement when the mempool first-seen evidence is unreliable', async () => {
    const hash = `0x${'cd'.repeat(32)}`;
    const sender = '0x2222222222222222222222222222222222222222';

    exchangerUtils.ETH.getTransaction.mockResolvedValue(
      incomingTx({
        senderId: sender,
        recipientId: '0x1417282226491840087900000000000000000000',
        amount: 100,
      }),
    );
    exchangerUtils.getKvsCryptoAddressRecord.mockResolvedValue({
      address: sender,
      height: 80,
      transactionId: 'old-kvs-tx',
    });
    depositClaims.getObservation.mockResolvedValue({
      firstSeenSource: 'eth-startup-snapshot',
      firstSeenReliable: false,
      firstSeenAt: Date.now() - 600000,
    });

    const pay = createPayment({
      transactionIsValid: null,
      inCurrency: 'ETH',
      outCurrency: 'ADM',
      inTxid: hash,
      depositKey: `eip155:1:${hash.slice(2)}`,
      senderKvsInAddress: undefined,
      senderKvsOutAddress: USER,
    });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(true);
    expect(pay.needHumanCheck).toBe(true);
    expect(pay.depositOwnershipStatus).toBe('manual-first-seen');
    expect(depositClaims.setClaimStatus).toHaveBeenCalledWith(
      pay._id,
      'manual',
      expect.objectContaining({ reason: 'manual-first-seen' }),
    );
  });

  test('never pays a claim funded by an operator-reserved top-up sender', async () => {
    const hash = `0x${'ef'.repeat(32)}`;
    const sender = '0x3333333333333333333333333333333333333333';

    exchangerUtils.ETH.getTransaction.mockResolvedValue(
      incomingTx({
        senderId: sender,
        recipientId: '0x1417282226491840087900000000000000000000',
        amount: 100,
      }),
    );
    exchangerUtils.getKvsCryptoAddressRecord.mockResolvedValue({
      address: sender,
      height: 80,
      transactionId: 'old-kvs-tx',
    });
    config.reserved_deposit_senders = [sender.toUpperCase()];

    try {
      const pay = createPayment({
        transactionIsValid: null,
        inCurrency: 'ETH',
        outCurrency: 'ADM',
        inTxid: hash,
        depositKey: `eip155:1:${hash.slice(2)}`,
        senderKvsInAddress: undefined,
        senderKvsOutAddress: USER,
      });

      await validator.validate(pay, admTx());

      expect(pay.transactionIsValid).toBe(true);
      expect(pay.needHumanCheck).toBe(true);
      expect(pay.depositOwnershipStatus).toBe('reserved-top-up-sender');
      expect(depositClaims.markManual).toHaveBeenCalledWith(pay.depositKey, 'reserved-top-up-sender');
    } finally {
      config.reserved_deposit_senders = [];
    }
  });

  test('rejects a transfer worth less than the user claimed', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(incomingTx({ amount: 10 }));

    const pay = createPayment({ transactionIsValid: null, inAmountMessage: 100 });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(false);
    expect(pay.error).toBe(constants.ERRORS.WRONG_AMOUNT);
  });

  test('tolerates a rounding-sized difference in the amount', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(incomingTx({ amount: 100.05 }));

    const pay = createPayment({ transactionIsValid: null, inAmountMessage: 100 });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(true);
  });

  test('rejects a transfer made far away in time from the in-chat message', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(
      incomingTx({ timestamp: utils.toTimestamp(ADM_TIMESTAMP) - constants.VALIDATOR_TIMESTAMP_DEVIATION - 1000 }),
    );

    const pay = createPayment({ transactionIsValid: null });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(false);
    expect(pay.error).toBe(constants.ERRORS.WRONG_TIMESTAMP);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('hours away from the in-chat message'), 'error');
  });

  test('accepts a transfer made shortly before the in-chat message', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(
      incomingTx({ timestamp: utils.toTimestamp(ADM_TIMESTAMP) - 60 * 1000 }),
    );

    const pay = createPayment({ transactionIsValid: null });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(true);
  });

  test('accepts an InstantSend transfer that carries no timestamp', async () => {
    exchangerUtils.ADM.getTransaction.mockResolvedValue(
      incomingTx({ timestamp: undefined, instantlock: true, instantlock_internal: true }),
    );

    const pay = createPayment({ transactionIsValid: null });

    await validator.validate(pay, admTx());

    expect(pay.transactionIsValid).toBe(true);
    expect(pay.inTxIsInstant).toBe(true);
  });

  test('logs and moves on when validation throws', async () => {
    exchangerUtils.ADM.getTransaction.mockRejectedValue(new Error('node exploded'));

    const pay = createPayment({ transactionIsValid: null });

    await expect(validator.validate(pay, admTx())).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to validate the Tx'));
  });
});

describe('deepExchangeValidator.run', () => {
  test('validates every payment that has passed the basic checks but is not verified', async () => {
    const pay = createPayment({ transactionIsValid: null });

    db.paymentsDb.find.mockResolvedValue([pay]);
    api.getTransaction.mockResolvedValue({ success: true, transaction: admTx() });

    await validator.run();

    expect(db.paymentsDb.find).toHaveBeenCalledWith({
      transactionIsValid: null,
      isBasicChecksPassed: true,
      isFinished: false,
    });
    expect(pay.transactionIsValid).toBe(true);
  });

  test('skips a payment whose ADAMANT transaction cannot be fetched', async () => {
    const pay = createPayment({ transactionIsValid: null });

    db.paymentsDb.find.mockResolvedValue([pay]);
    api.getTransaction.mockResolvedValue({ success: false, errorMessage: 'node down' });

    await validator.run();

    expect(pay.transactionIsValid).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unable to fetch the ADM Tx'));
  });
});
