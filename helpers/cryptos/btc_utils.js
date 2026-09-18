const { btc } = require('adamant-api/coins/btc');

const config = require('../../modules/configReader');
const log = require('../log');
const utils = require('../utils');
const { NodeClient } = require('./nodeClient');
const BtcBaseCoin = require('./btcBaseCoin');

/** How often the fee estimate is refreshed. */
const UPDATE_FEE_RATE_INTERVAL = 60 * 1000;

/**
 * Assumed transaction size, in virtual bytes.
 *
 * The bot's transfers are P2PKH: roughly 181 vbytes per input and 34 per output,
 * plus a 10-byte overhead. Three inputs and two outputs — the recipient and the
 * change — cover the common case with room to spare.
 */
const ASSUMED_TX_VSIZE = 3 * 181 + 2 * 34 + 10;

/** Fee used until the first estimate arrives, or when the node does not provide one, in BTC. */
const FALLBACK_FEE = 0.0001;

/** Outputs below this many satoshi are not relayed. */
const DUST_THRESHOLD = 546;

/**
 * Bitcoin adapter.
 *
 * Talks to an Esplora-compatible node, the API the ADAMANT Bitcoin nodes expose.
 */
module.exports = class BtcCoin extends BtcBaseCoin {
  /** @param {string} token Ticker, `BTC` */
  constructor(token) {
    super(token, btc, config.passPhrase);

    this.client = new NodeClient(token, config.node_BTC);

    this.cache.balance = { lifetime: 60000 };
    this.cache.lastBlock = { lifetime: 180000 };
    this.cache.fee = { lifetime: UPDATE_FEE_RATE_INTERVAL };
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
   * Estimated transfer fee, in BTC.
   *
   * @returns {number}
   */
  get FEE() {
    const cached = this.cache.getData('fee', false);

    return cached ? this.fromSat(cached) : FALLBACK_FEE;
  }

  /**
   * Refreshes the cached fee estimate.
   *
   * @returns {Promise<void>}
   */
  async getFeeRate() {
    const feeEstimates = await this.client.request({ endpoint: '/fee-estimates', description: 'fee estimates' });
    const satPerVbyte = feeEstimates?.['2'];

    if (!utils.isPositiveNumber(satPerVbyte)) {
      log.warn(
        `Failed to get fee estimates for ${this.token} in getFeeRate() of ${utils.getModuleName(module.id)} module. Keeping the previous estimate.`,
      );

      return;
    }

    this.cache.cacheData('fee', Math.ceil(ASSUMED_TX_VSIZE * satPerVbyte));
  }

  /**
   * Starts refreshing the fee estimate in the background.
   *
   * @returns {Promise<void>}
   */
  async startFeeUpdates() {
    await this.getFeeRate();

    log.log(`Estimated ${this.token} Tx fee: ${this.FEE.toFixed(this.decimals)}`);

    this.feeInterval = setInterval(() => {
      void this.getFeeRate();
    }, UPDATE_FEE_RATE_INTERVAL);

    this.feeInterval.unref?.();
  }

  /**
   * Returns the bot's BTC balance, from cache when it is fresh.
   *
   * Unconfirmed movements are included: the change output of a payout the bot has
   * just made is spendable, and counting only confirmed funds would make the bot
   * believe it is out of money until the next block.
   *
   * @returns {Promise<number|undefined>} Balance in BTC; a stale cached value when the request fails
   */
  async getBalance() {
    const cached = this.cache.getData('balance', true);

    if (cached !== undefined) {
      return this.fromSat(cached);
    }

    const stats = await this.client.request({
      endpoint: `/address/${this.address}`,
      description: 'address balance',
    });

    if (stats?.chain_stats) {
      const confirmed = stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum;
      const unconfirmed = stats.mempool_stats
        ? stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum
        : 0;
      const balance = confirmed + unconfirmed;

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

    const height = await this.client.request({ endpoint: '/blocks/tip/height', description: 'chain tip height' });

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
    const tx = await this.client.request({ endpoint: `/tx/${txid}`, description: `Tx ${txid}`, quiet: true });

    if (typeof tx !== 'object' || tx === null) {
      return undefined;
    }

    const formedTx = this.mapEsploraTransaction(tx);

    if (!disableLogging) {
      log.log(`${this.token} Tx status: ${this.formTxMessage(formedTx)}.`);
    }

    return formedTx;
  }

  /**
   * Fetches a transaction's raw hex.
   *
   * PSBT needs the full previous transaction to sign a P2PKH input.
   *
   * @param {string} txid Transaction ID
   * @returns {Promise<string|undefined>}
   */
  async getTransactionHex(txid) {
    const hex = await this.client.request({ endpoint: `/tx/${txid}/hex`, description: `raw Tx ${txid}` });

    return typeof hex === 'string' ? hex.trim() : undefined;
  }

  /**
   * Returns the bot's unspent outputs, each with the raw hex of the transaction that created it.
   *
   * @returns {Promise<Array<{txid: string, vout: number, amount: number, hex: string}>|undefined>}
   */
  async getUnspents() {
    const outputs = await this.client.request({
      endpoint: `/address/${this.address}/utxo`,
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

      unspents.push({ txid: output.txid, vout: output.vout, amount: output.value, hex });
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
    const txid = await this.client.request({
      endpoint: '/tx',
      method: 'post',
      data: txHex,
      description: 'broadcast Tx',
    });

    return typeof txid === 'string' ? txid.trim() : undefined;
  }

  /**
   * Normalizes an Esplora transaction into the shape {@link BtcBaseCoin#mapTransaction} expects.
   *
   * Esplora reports amounts in satoshi and names its address fields differently from
   * Insight- and Core-style nodes.
   *
   * @param {object} tx Esplora transaction
   * @returns {object} Transaction in the bot's common shape
   */
  mapEsploraTransaction(tx) {
    const mapped = this.mapTransaction({
      ...tx,
      vin: tx.vin.map((input) => ({ ...input, address: input.prevout?.scriptpubkey_address })),
      vout: tx.vout.map((out) => ({
        ...out,
        scriptPubKey: { addresses: out.scriptpubkey_address ? [out.scriptpubkey_address] : [] },
      })),
      fees: tx.fee,
      time: tx.status?.block_time,
      blockhash: tx.status?.block_hash,
    });

    mapped.amount = this.fromSat(mapped.amount);
    mapped.fee = this.fromSat(mapped.fee);
    mapped.height = tx.status?.block_height;

    // `confirmed: false` only means the Tx is still in the mempool, not that it failed.
    if (tx.status?.confirmed) {
      mapped.status = true;
    }

    return mapped;
  }
};
