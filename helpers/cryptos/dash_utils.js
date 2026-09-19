const { dash } = require('adamant-api/coins/dash');

const config = require('../../modules/configReader');
const log = require('../log');
const utils = require('../utils');
const { NodeClient } = require('./nodeClient');
const BtcBaseCoin = require('./btcBaseCoin');

/** Fixed transfer fee, in DASH. */
const TRANSFER_FEE = 0.0001;

/** Outputs below this many duffs are not relayed. */
const DUST_THRESHOLD = 5460;

/**
 * Dash adapter.
 *
 * Talks to a Dash Core node over JSON-RPC. The node runs with the address index
 * enabled, which is what makes `getaddressbalance` and `getaddressutxos` available
 * and what puts the spent address on every input.
 */
module.exports = class DashCoin extends BtcBaseCoin {
  /** @param {string} token Ticker, `DASH` */
  constructor(token) {
    super(token, dash, config.passPhrase);

    this.client = new NodeClient(token, config.node_DASH);

    this.cache.balance = { lifetime: 60000 };
    this.cache.lastBlock = { lifetime: 90000 };
  }

  /** @returns {number} */
  get decimals() {
    return 8;
  }

  /** @returns {number} */
  get dustThreshold() {
    return DUST_THRESHOLD;
  }

  /**
   * Fixed transfer fee, in DASH.
   *
   * @returns {number}
   */
  get FEE() {
    return TRANSFER_FEE;
  }

  /**
   * Returns the bot's DASH balance, from cache when it is fresh.
   *
   * @returns {Promise<number|undefined>} Balance in DASH; a stale cached value when the request fails
   */
  async getBalance() {
    const cached = this.cache.getData('balance', true);

    if (cached !== undefined) {
      return this.fromSat(cached);
    }

    const result = await this.client.rpc('getaddressbalance', [this.address]);

    if (result?.balance !== undefined) {
      this.cache.cacheData('balance', result.balance);

      return this.fromSat(result.balance);
    }

    log.warn(
      `Failed to get the balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module; returning the outdated cached balance.`,
    );

    return this.fromSat(this.cache.getData('balance', false));
  }

  /**
   * Returns the chain tip height, from cache when it is fresh.
   *
   * @returns {Promise<number|undefined>}
   */
  async getLastBlock() {
    const cached = this.cache.getData('lastBlock', true);

    if (cached) {
      return cached;
    }

    const height = await this.client.rpc('getblockcount');

    if (!utils.isPositiveNumber(height)) {
      log.warn(
        `Failed to get the last block in getLastBlock() for ${this.token} of ${utils.getModuleName(module.id)} module. Received: ${height}`,
      );

      return undefined;
    }

    this.cache.cacheData('lastBlock', height);

    return height;
  }

  /**
   * Fetches a transaction and maps it to the bot's common shape.
   *
   * @param {string} txid Transaction ID
   * @param {boolean} [disableLogging] Do not log the result; used for bulk lookups
   * @returns {Promise<object|undefined>}
   */
  async getTransaction(txid, disableLogging = false) {
    const tx = await this.client.rpc('getrawtransaction', [txid, true], { quiet: true });

    if (typeof tx !== 'object' || tx === null) {
      return undefined;
    }

    const formedTx = this.mapCoreTransaction(tx);

    if (!disableLogging) {
      log.log(`${this.token} Tx status: ${this.formTxMessage(formedTx)}.`);
    }

    return formedTx;
  }

  /**
   * Returns transactions currently in the mempool that touch the bot's address.
   *
   * @returns {Promise<object[]|undefined>}
   */
  async getPendingIncomingTransactions() {
    const entries = await this.client.rpc('getaddressmempool', [{ addresses: [this.address] }]);

    if (!Array.isArray(entries)) {
      return undefined;
    }

    const txids = [...new Set(entries.map((entry) => entry.txid).filter(Boolean))];
    const transactions = await Promise.all(txids.map((txid) => this.getTransaction(txid, true)));

    return transactions.filter((tx) => tx && utils.isStringEqualCI(tx.recipientId, this.address));
  }

  /**
   * Fetches a transaction's raw hex.
   *
   * @param {string} txid Transaction ID
   * @returns {Promise<string|undefined>}
   */
  async getTransactionHex(txid) {
    const hex = await this.client.rpc('getrawtransaction', [txid]);

    return typeof hex === 'string' ? hex.trim() : undefined;
  }

  /**
   * Returns the bot's unspent outputs, each with the raw hex of the transaction that created it.
   *
   * @returns {Promise<Array<{txid: string, vout: number, amount: number, hex: string}>|undefined>}
   */
  async getUnspents() {
    const outputs = await this.client.rpc('getaddressutxos', [this.address]);

    if (!Array.isArray(outputs)) {
      return undefined;
    }

    const unspents = [];

    for (const output of outputs) {
      const hex = await this.getTransactionHex(output.txid);

      if (!hex) {
        log.warn(
          `Skipping the unspent output ${output.txid}:${output.outputIndex} — its raw ${this.token} Tx is unavailable.`,
        );
        continue;
      }

      unspents.push({ txid: output.txid, vout: output.outputIndex, amount: output.satoshis, hex });
    }

    return unspents;
  }

  /**
   * Broadcasts a signed transaction.
   *
   * @param {string} txHex Raw transaction, as a hex string
   * @returns {Promise<string|undefined>} Transaction ID, or `undefined` when the broadcast failed
   */
  async sendTransaction(txHex) {
    const txid = await this.client.rpc('sendrawtransaction', [txHex]);

    return typeof txid === 'string' ? txid.trim() : undefined;
  }

  /**
   * Normalizes a Dash Core transaction into the shape {@link BtcBaseCoin#mapTransaction} expects.
   *
   * Dash Core 18 and newer report a single `scriptPubKey.address`; older builds
   * report `scriptPubKey.addresses`. Both are accepted here so the adapter keeps
   * working across node upgrades.
   *
   * @param {object} tx Dash Core transaction
   * @returns {object} Transaction in the bot's common shape
   */
  mapCoreTransaction(tx) {
    return this.mapTransaction({
      ...tx,
      vout: tx.vout.map((out) => ({
        ...out,
        scriptPubKey: {
          ...out.scriptPubKey,
          addresses: out.scriptPubKey?.addresses ?? (out.scriptPubKey?.address ? [out.scriptPubKey.address] : []),
        },
      })),
    });
  }
};
