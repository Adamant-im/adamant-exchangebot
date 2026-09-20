const { doge } = require('adamant-api/coins/doge');

const config = require('../../modules/configReader');
const log = require('../log');
const utils = require('../utils');
const { NodeClient } = require('./nodeClient');
const BtcBaseCoin = require('./btcBaseCoin');

/** Fixed transfer fee, in DOGE. */
const TRANSFER_FEE = 1;

/** Outputs below this many koinu — 0.01 DOGE — are not relayed. */
const DUST_THRESHOLD = 1000000;

/**
 * Upper bound on the fee rate, in koinu per virtual byte.
 *
 * Dogecoin's fixed one-DOGE fee is a very high rate by Bitcoin standards — around
 * 440 000 koinu/vB on a small transfer — so the library's default ceiling has to be
 * raised for the transaction to be extractable at all. The guard still catches a
 * fee that is wrong by an order of magnitude.
 */
const MAXIMUM_FEE_RATE = 1000000;

/**
 * Dogecoin adapter.
 *
 * Talks to an Insight-compatible node, the API the ADAMANT Dogecoin nodes expose.
 */
module.exports = class DogeCoin extends BtcBaseCoin {
  /** @param {string} token Ticker, `DOGE` */
  constructor(token) {
    super(token, doge, config.passPhrase);

    this.client = new NodeClient(token, config.node_DOGE);

    this.cache.balance = { lifetime: 30000 };
    this.cache.lastBlock = { lifetime: 60000 };
  }

  /** @returns {number} */
  get decimals() {
    return 8;
  }

  /** @returns {number} */
  get dustThreshold() {
    return DUST_THRESHOLD;
  }

  /** @returns {number} */
  get maximumFeeRate() {
    return MAXIMUM_FEE_RATE;
  }

  /**
   * Fixed transfer fee, in DOGE.
   *
   * @returns {number}
   */
  get FEE() {
    return TRANSFER_FEE;
  }

  /**
   * Returns the bot's DOGE balance, from cache when it is fresh.
   *
   * @returns {Promise<number|undefined>} Balance in DOGE; a stale cached value when the request fails
   */
  async getBalance() {
    const cached = this.cache.getData('balance', true);

    if (cached !== undefined) {
      return this.fromSat(cached);
    }

    const balance = await this.client.request({
      endpoint: `/api/addr/${this.address}/balance`,
      description: 'address balance',
    });

    if (utils.isPositiveOrZeroNumber(balance)) {
      this.cache.cacheData('balance', balance);

      return this.fromSat(balance);
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

    const status = await this.client.request({ endpoint: '/api/status', description: 'node status' });
    const height = status?.info?.blocks;

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
    const tx = await this.client.request({ endpoint: `/api/tx/${txid}`, description: `Tx ${txid}`, quiet: true });

    if (typeof tx !== 'object' || tx === null) {
      return undefined;
    }

    const formedTx = this.mapInsightTransaction(tx);

    if (!disableLogging) {
      log.log(`${this.token} Tx status: ${this.formTxMessage(formedTx)}.`);
    }

    return formedTx;
  }

  /**
   * Returns unconfirmed transactions involving the bot's address.
   *
   * @returns {Promise<object[]|undefined>}
   */
  async getPendingIncomingTransactions() {
    const response = await this.client.request({
      endpoint: `/api/txs/?address=${this.address}&pageNum=0`,
      description: 'pending incoming transactions',
      // The deposit watcher reports failures itself, at a bounded rate.
      quiet: true,
    });
    const entries = Array.isArray(response?.txs) ? response.txs : Array.isArray(response) ? response : undefined;

    if (!entries) {
      return undefined;
    }

    const txids = entries
      .filter((tx) => !tx.confirmations && !tx.blockheight && !tx.blockhash)
      .map((tx) => tx.txid)
      .filter(Boolean);
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
    const result = await this.client.request({ endpoint: `/api/rawtx/${txid}`, description: `raw Tx ${txid}` });

    return typeof result?.rawtx === 'string' ? result.rawtx.trim() : undefined;
  }

  /**
   * Returns the bot's unspent outputs, each with the raw hex of the transaction that created it.
   *
   * `noCache=1` is required: a cached UTXO list can still list outputs the bot has
   * just spent, and building a transfer on them produces a rejected double spend.
   *
   * @returns {Promise<Array<{txid: string, vout: number, amount: number, hex: string}>|undefined>}
   */
  async getUnspents() {
    const outputs = await this.client.request({
      endpoint: `/api/addr/${this.address}/utxo?noCache=1`,
      description: 'unspent outputs',
    });

    if (!Array.isArray(outputs)) {
      return undefined;
    }

    const unspents = [];

    for (const output of outputs) {
      const hex = await this.getTransactionHex(output.txid);

      if (!hex) {
        log.warn(
          `Skipping the unspent output ${output.txid}:${output.vout} — its raw ${this.token} Tx is unavailable.`,
        );
        continue;
      }

      unspents.push({
        txid: output.txid,
        vout: output.vout,
        // Insight reports `satoshis` alongside the DOGE `amount`; prefer the integer.
        amount: output.satoshis ?? this.toSat(output.amount),
        hex,
      });
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
    const result = await this.client.request({
      endpoint: '/api/tx/send',
      method: 'post',
      data: { rawtx: txHex },
      description: 'broadcast Tx',
    });

    return typeof result?.txid === 'string' ? result.txid.trim() : undefined;
  }

  /**
   * Normalizes an Insight transaction into the shape {@link BtcBaseCoin#mapTransaction} expects.
   *
   * Insight names the input address `addr` and reports amounts in DOGE rather than koinu.
   *
   * @param {object} tx Insight transaction
   * @returns {object} Transaction in the bot's common shape
   */
  mapInsightTransaction(tx) {
    return this.mapTransaction({
      ...tx,
      vin: tx.vin.map((input) => ({ ...input, address: input.address ?? input.addr })),
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
