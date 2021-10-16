const config = require('../../modules/configReader');
const log = require('../log');
const utils = require('../utils');

const btcNode = config.node_BTC[0]; // TODO: health check
const axios = require('axios');

const updateFeeRateInterval = 60 * 1000; // Update fee rate every minute

const btcBaseCoin = require('./btcBaseCoin');
module.exports = class btcCoin extends btcBaseCoin {

  constructor(token) {
    super(token);
    this.cache.balance = { lifetime: 60000 };
    this.cache.lastBlock = { lifetime: 180000 };
    this.cache.fee = { lifetime: updateFeeRateInterval };
    this.getFeeRate().then(() => {
      log.log(`Estimate ${this.token} Tx fee: ${this.FEE.toFixed(this.decimals)}`);
    });
    setInterval(() => {
      this.getFeeRate();
    }, updateFeeRateInterval);
  }

  /**
   * Returns BTC decimals (precision)
   * @override
   * @return {Number}
   */
  get decimals() {
    return 8;
  }

  /**
   * Returns estimate tx fee for transfers in BTC
   * @return {Number}
   */
  get FEE() {
    try {
      const cached = this.cache.getData('fee', false);
      if (cached) { // fee is a number in sat
        return this.fromSat(cached);
      } else {
        return 0.0001; // default
      }
    } catch (e) {
      log.warn(`Error while calculating Tx fee for ${this.token} in FEE() of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Updates estimate tx fee in sat to cache
   */
  async getFeeRate() {
    try {
      const feeRate = await requestBitcoin('/fee-estimates');
      if (feeRate && feeRate['2']) {
        // Estimated tx size is: ins * 180 + outs * 34 + 10 (https://news.bitcoin.com/how-to-calculate-bitcoin-transaction-fees-when-youre-in-a-hurry/)
        // We assume that there're always 2 outputs: transfer target and the remains, and 3 inputs
        const fee = Math.ceil((3 * 181 + 78) * feeRate['2']);
        this.cache.cacheData('fee', fee);
      } else {
        const feeRateErrorMessage = feeRate && feeRate.errorMessage ? ' ' + feeRate.errorMessage : '';
        log.warn(`Failed to get fee estimates in getFeeRate() for ${this.token} of ${utils.getModuleName(module.id)} module.${feeRateErrorMessage}`);
      }
    } catch (e) {
      log.warn(`Error while getting fee estimates in getFeeRate() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Returns balance in BTC from cache, if it's up to date. If not, makes an API request and updates cached data.
   * @override
   * @return {Number} or outdated cached value, if unable to fetch data; it may be undefined also
   */
  async getBalance() {
    try {

      const cached = this.cache.getData('balance', true);
      if (cached) { // balance is a number in sat
        return this.fromSat(cached);
      }

      let balance = await requestBitcoin(`/address/${this.address}`);
      if (balance && balance.chain_stats) {
        balance = balance.chain_stats.funded_txo_sum - balance.chain_stats.spent_txo_sum;
        this.cache.cacheData('balance', balance);
        return this.fromSat(balance);
      } else {
        const balanceErrorMessage = balance && balance.errorMessage ? ' ' + balance.errorMessage : '';
        log.warn(`Failed to get balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module; returning outdated cached balance.${balanceErrorMessage}`);
        return this.fromSat(this.cache.getData('balance', false));
      }

    } catch (e) {
      log.warn(`Error while getting balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Returns balance in BTC from cache. It may be outdated.
   * @override
   * @return {Number} cached value; it may be undefined
   */
  get balance() {
    try {
      return this.fromSat(this.cache.getData('balance', false));
    } catch (e) {
      log.warn(`Error while getting balance in balance() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Updates BTC balance in cache. Useful when we don't want to wait for network update.
   * @override
   * @param {Number} value New balance in BTC
   */
  set balance(value) {
    try {
      if (utils.isPositiveOrZeroNumber(value)) {
        this.cache.cacheData('balance', this.toSat(value));
      }
    } catch (e) {
      log.warn(`Error setting balance in balance() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Returns last block of BTC blockchain from cache, if it's up to date.
   * If not, makes an API request and updates cached data.
   * Used only for this.getLastBlockHeight()
   * @override
   * @return {Object} or undefined, if unable to get block info
   */
  getLastBlock() {
    const cached = this.cache.getData('lastBlock', true);
    if (cached) {
      return cached;
    }
    return requestBitcoin('/blocks/tip/height').then((result) => {
      if (utils.isPositiveNumber(result)) {
        this.cache.cacheData('lastBlock', result);
        return result;
      } else {
        log.warn(`Failed to get last block in getLastBlock() of ${utils.getModuleName(module.id)} module. Received value: ` + result);
      }
    });
  }

  /**
   * Returns last block height of BTC blockchain
   * @override
   * @return {Number} or undefined, if unable to get block info
   */
  async getLastBlockHeight() {
    const block = await this.getLastBlock();
    return block ? block : undefined;
  }

  /**
   * Returns Tx status and details from the blockchain
   * @override
   * @param {String} txid Tx ID to fetch
   * @return {Object}
   * Used for income Tx security validation (deepExchangeValidator): senderId, recipientId, amount, timestamp
   * Used for checking income Tx status (confirmationsCounter), exchange and send-back Tx status (sentTxChecker):
   * status, confirmations || height
   * Not used, additional info: hash (already known), blockId, fee, recipients, senders
   */
  async getTransaction(txid, disableLogging = false) {
    return requestBitcoin(`/tx/${txid}`).then((result) => {
      if (typeof result !== 'object') return undefined;
      const formedTx = this._mapTransaction(result);
      if (!disableLogging) log.log(`${this.token} tx status: ${this.formTxMessage(formedTx)}.`);
      return formedTx;
    });
  }

  /**
   * Retrieves unspents (UTXO)
   * @override
   * @return {Promise<Array<{txid: string, vout: number, amount: number}>>} or undefined
   */
  getUnspents() {
    return requestBitcoin(`/address/${this.address}/utxo`).then((outputs) =>
      outputs.map((x) => ({ txid: x.txid, amount: x.value, vout: x.vout })),
    );

    return requestBitcoin(`/address/${this.address}/utxo`).then(async (result) => {
      if (!Array.isArray(result)) return undefined;
      // For bitcoinjs-lib starting 6.0.0 (in 5.0.2 TransactionsBuilder is deprecated),
      // We need raw Tx as nonWitnessUtxo for every input (unspent)
      let fullTx;
      for (const tx of result) {
        fullTx = await this.getTransaction(tx.txid);
        tx.hex = fullTx && fullTx.hex ? fullTx.hex : undefined;
      }
      return result.map((tx) => ({
        hash: tx.txid,
        amount: tx.satoshis, // to calc transferAmount in _buildTransaction()
        index: tx.outputIndex,
        nonWitnessUtxo: Buffer.from(tx.hex, 'hex'),
      }));
    });
  }

  /**
   * Broadcasts the specified transaction to the BTC network
   * @override
   * @param {string} txHex raw transaction as a HEX literal
   */
  sendTransaction(txHex) {
    return requestBitcoin('/tx', txHex).then((txid) => {
      return txid;
    });
  }

  /** @override */
  _mapTransaction(tx) {
    const mapped = super._mapTransaction({
      ...tx,
      vin: tx.vin.map((x) => ({ ...x, addr: x.prevout.scriptpubkey_address })),
      vout: tx.vout.map((x) => ({
        ...x,
        scriptPubKey: { addresses: [x.scriptpubkey_address] },
      })),
      fees: tx.fee,
      time: tx.status.block_time,
      // confirmations: tx.status.confirmed ? 1 : 0,
      blockhash: tx.status.block_hash,
    });

    mapped.amount = this.fromSat(mapped.amount);
    mapped.fee = this.fromSat(mapped.fee);
    mapped.height = tx.status.block_height;

    return mapped;
  }

};

/**
 * Makes a GET request to Bitcoin node. Internal function.
 * @param {string} endpoint Endpoint name
 * @param {*} params Endpoint params
 * @return {*} Request results or undefined
 */
function requestBitcoin(endpoint, params) {
  // console.log('btc request', endpoint, params);
  const httpOptions = {
    url: btcNode + endpoint,
    method: params ? 'post' : 'get',
  };
  return axios(httpOptions, params)
      .then((response) => {
        // console.log('btc response', response);
        response = formatRequestResults(response, true);
        // console.log('btc formatted response', response);
        if (response.success) {
          return response.data;
        } else {
          log.warn(`Request to ${endpoint} RPC returned an error: ${response.errorMessage}.`);
        }
      })
      .catch(function(error) {
        log.warn(`Request to ${endpoint} RPC in ${utils.getModuleName(module.id)} module failed. ${formatRequestResults(error, false).errorMessage}.`);
      });
}

/**
 * Formats axios request results. Internal function.
 * @param {object} response Axios response
 * @param {boolean} isRequestSuccess If axios request succeed
 * @return {object} Formatted request results
 */
function formatRequestResults(response, isRequestSuccess) {

  const results = {};
  results.details = {};

  if (isRequestSuccess) {
    results.success = response.data && !response.data.error;
    results.data = response.data;
    results.details.status = response.status;
    results.details.statusText = response.statusText;
    results.details.response = response;
    if (!results.success && results.data) {
      results.errorMessage = `Node's reply: ${results.data.error}`;
    }
  } else {
    results.success = false;
    results.data = response.response && response.response.data;
    results.details.status = response.response ? response.response.status : undefined;
    results.details.statusText = response.response ? response.response.statusText : undefined;
    results.details.error = response.toString();
    if (response.response && response.response.data && response.response.data.error) {
      results.details.message = typeof response.response.data.error == 'object' ? JSON.stringify(response.response.data.error) : response.response.data.error.toString().trim();
    }
    results.details.response = response.response;
    results.errorMessage = `${results.details.error}${results.details.message ? '. Message: ' + results.details.message : ''}`;
  }

  return results;

}
