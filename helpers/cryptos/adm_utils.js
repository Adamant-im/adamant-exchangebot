const { isAdmAddress, MessageType } = require('adamant-api');

const api = require('../../modules/api');
const log = require('../log');
const constants = require('../const');
const config = require('../../modules/configReader');
const utils = require('../utils');
const BaseCoin = require('./baseCoin');

/** Fixed ADAMANT transfer fee, in ADM. */
const ADM_TRANSFER_FEE = 0.5;

/**
 * Failures `adamant-api` reports before it sends anything: its own parameter
 * validation, a recipient public key it could not resolve, and the absence of a
 * compatible node. Matched at the start of the message, in the exact form the SDK
 * builds them, so a node's reply can never be mistaken for one.
 */
const SDK_PRE_FLIGHT_FAILURES = [
  /^Wrong '[^']+' parameter/,
  /^Unable to get public key for /,
  /^No compatible ADAMANT nodes are available/,
];

/**
 * Tells whether a failed ADM send provably never reached the network.
 *
 * Only these failures may be retried automatically. Anything else — a timeout, a lost
 * reply, "already exists" after a retried POST — may mean the transfer was accepted.
 *
 * @param {string} errorMessage Error returned by `adamant-api`
 * @returns {boolean}
 */
function isDefinitePreBroadcastFailure(errorMessage) {
  if (typeof errorMessage !== 'string') {
    return false;
  }

  return (
    /(does not have enough adm|insufficient funds|insufficient balance)/i.test(errorMessage) ||
    SDK_PRE_FLIGHT_FAILURES.some((pattern) => pattern.test(errorMessage))
  );
}

/**
 * Tells whether a failed ADM send may have reached the network.
 *
 * @param {string} errorMessage Error returned by `adamant-api`
 * @returns {boolean}
 */
function isAmbiguousBroadcastOutcome(errorMessage) {
  return typeof errorMessage === 'string' && !isDefinitePreBroadcastFailure(errorMessage);
}

/**
 * ADAMANT (ADM) adapter.
 *
 * ADM is special among the supported coins: the bot already holds the passphrase,
 * and an ADM payout is an in-chat transfer, so the payment and the message to the
 * user are one and the same transaction.
 */
module.exports = class AdmCoin extends BaseCoin {
  constructor() {
    super();

    this.token = 'ADM';
    this.decimals = 8;

    this.cache.lastBlock = { lifetime: 4000 };
    this.cache.balance = { lifetime: 4000 };

    this.account.passPhrase = config.passPhrase;
    this.account.keyPair = config.keyPair;
    this.account.address = config.address;
  }

  /**
   * Fixed transfer fee, in ADM.
   *
   * @returns {number}
   */
  get FEE() {
    return ADM_TRANSFER_FEE;
  }

  /**
   * Checks that an address is a valid ADAMANT address.
   *
   * @param {string} address Address to validate
   * @returns {boolean}
   */
  isValidAddress(address) {
    return isAdmAddress(address);
  }

  /**
   * Returns the last block, from cache when it is fresh.
   *
   * @returns {Promise<object|undefined>} Block info, or `undefined` when it could not be fetched
   */
  async getLastBlock() {
    const cached = this.cache.getData('lastBlock', true);

    if (cached) {
      return cached;
    }

    const response = await api.getBlocks({ limit: 1 });

    if (!response.success) {
      log.warn(
        `Failed to get the last block in getLastBlock() of ${utils.getModuleName(module.id)} module. ${response.errorMessage}.`,
      );

      return undefined;
    }

    const block = response.blocks?.[0];

    if (block) {
      this.cache.cacheData('lastBlock', block);
    }

    return block;
  }

  /**
   * Returns the last block height.
   *
   * @returns {Promise<number|undefined>} Height, or `undefined` when it could not be fetched
   */
  async getLastBlockHeight() {
    const block = await this.getLastBlock();

    return block ? block.height : undefined;
  }

  /**
   * Returns the bot's ADM balance, from cache when it is fresh.
   *
   * @returns {Promise<number|undefined>} Balance in ADM; a stale cached value when the request fails
   */
  async getBalance() {
    const cached = this.cache.getData('balance', true);

    if (cached !== undefined) {
      return utils.satsToADM(cached);
    }

    const response = await api.getAccountInfo({ address: this.account.address });

    if (response.success) {
      this.cache.cacheData('balance', response.account.balance);

      return utils.satsToADM(response.account.balance);
    }

    log.warn(
      `Failed to get account info in getBalance() of ${utils.getModuleName(module.id)} module; returning the outdated cached balance. ${response.errorMessage}.`,
    );

    return utils.satsToADM(this.cache.getData('balance', false));
  }

  /**
   * Returns the cached ADM balance, which may be outdated.
   *
   * @returns {number|undefined}
   */
  get balance() {
    return utils.satsToADM(this.cache.getData('balance', false));
  }

  /**
   * Updates the cached ADM balance.
   *
   * Used right after a payout so the next payment sees the reduced balance
   * without waiting for a network round trip.
   *
   * @param {number} value New balance, in ADM
   */
  set balance(value) {
    if (utils.isPositiveOrZeroNumber(value)) {
      this.cache.cacheData('balance', utils.admToSats(value));
    }
  }

  /**
   * Fetches a transaction from the ADAMANT blockchain.
   *
   * @param {string} txid Transaction ID
   * @returns {Promise<object|null>} Transaction in the bot's common shape, or `null` when it is not found
   */
  async getTransaction(txid) {
    const response = await api.getTransaction(txid);

    if (!response.success) {
      log.warn(
        `Unable to get Tx ${txid} in getTransaction() of ${utils.getModuleName(module.id)} module. This is expected while the Tx is new. ${response.errorMessage}.`,
      );

      return null;
    }

    const tx = response.transaction;
    const formedTx = {
      // The node does not expose a failure state for a confirmed Tx, so `undefined`
      // means "not confirmed yet" rather than "failed".
      status: tx.confirmations > 0 ? true : undefined,
      height: tx.height,
      blockId: tx.blockId,
      timestamp: utils.toTimestamp(tx.timestamp),
      hash: tx.id,
      senderId: tx.senderId,
      recipientId: tx.recipientId,
      confirmations: tx.confirmations,
      amount: utils.satsToADM(tx.amount),
      fee: utils.satsToADM(tx.fee),
    };

    log.log(`${this.token} Tx status: ${this.formTxMessage(formedTx)}.`);

    return formedTx;
  }

  /**
   * Sends ADM with a message attached.
   *
   * @param {object} params Transfer parameters
   * @param {string} params.address Recipient's ADM address
   * @param {number} params.value Amount, in ADM
   * @param {string} params.comment In-chat message sent with the transfer
   * @param {number} [params.try] Attempt number, for logging
   * @returns {Promise<{success: boolean, hash?: string, error?: string}>}
   */
  async send(params) {
    const { address, value, comment } = params;
    const attempt = params.try || 1;
    const attemptInfo = ` (attempt ${attempt})`;

    if (!this.isValidAddress(address)) {
      const error = `'${address}' is not a valid ${this.token} address`;

      log.error(`Refusing to send ${value} ${this.token}: ${error}.`);

      return { success: false, error };
    }

    let payment;

    try {
      // `true` marks the amount as ADM rather than sats.
      payment = await api.sendMessage(config.passPhrase, address, comment, MessageType.Chat, value, true);
    } catch (error) {
      // An unexpected throw leaves the outcome unknown: the transaction may already be in
      // the network. The caller must not retry it.
      log.error(`Error while sending ${value} ${this.token} to ${address}${attemptInfo}. ${error}`);

      return { success: false, isAmbiguous: true, error: String(error) };
    }

    if (payment.success) {
      log.log(
        `Successfully sent ${value} ${this.token} to ${address} with the comment '${comment}'${attemptInfo}, Tx hash: ${payment.transactionId}.`,
      );

      return { success: true, hash: payment.transactionId };
    }

    log.warn(
      `Failed to send ${value} ${this.token} to ${address} with the comment '${comment}'${attemptInfo} in send() of ${utils.getModuleName(module.id)} module. ${payment.errorMessage}.`,
    );

    if (isAmbiguousBroadcastOutcome(payment.errorMessage)) {
      return { success: false, isAmbiguous: true, error: payment.errorMessage };
    }

    return { success: false, error: payment.errorMessage };
  }

  /**
   * Builds a human-readable one-line description of a transaction.
   *
   * @param {object} tx Transaction in the bot's common shape
   * @returns {string}
   */
  formTxMessage(tx) {
    const senderId = utils.isStringEqualCI(tx.senderId, this.account.address) ? 'Me' : tx.senderId;
    const recipientId = utils.isStringEqualCI(tx.recipientId, this.account.address) ? 'Me' : tx.recipientId;

    return (
      `Tx ${tx.hash} for ${tx.amount} ${this.token} from ${senderId} to ${recipientId} ` +
      `is included at ${tx.height} blockchain height and has ${tx.confirmations} confirmations, ` +
      `${tx.fee} ${this.token} fee`
    );
  }

  /**
   * Logs the balance the bot starts with, so an operator can spot an empty wallet immediately.
   *
   * @returns {Promise<void>}
   */
  async logInitialState() {
    const balance = await this.getBalance();

    log.log(
      `Initial ${this.token} balance: ${
        utils.isPositiveOrZeroNumber(balance) ? balance.toFixed(constants.PRINT_DECIMALS) : 'unable to receive'
      }`,
    );
  }
};
