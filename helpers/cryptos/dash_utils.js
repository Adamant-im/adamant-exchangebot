const config = require('../../modules/configReader');
const log = require('../log');
const utils = require('../utils');

const dashNode = config.node_DASH[0]; // TODO: health check
const axios = require('axios');

const btcBaseCoin = require('./btcBaseCoin');
module.exports = class dashCoin extends btcBaseCoin {

  constructor(token) {
    super(token)
    this.cache.balance = { lifetime: 60000 };
    this.cache.lastBlock = { lifetime: 90000 };
  }

  /**
   * Returns DASH decimals (precision)
   * @override
   * @returns {Number}
   */
  get decimals() {
    return 8
  }

  /**
   * Returns fixed fee for transfers
   * @returns {Number}
   */
  get FEE() {
    return 0.0001;
  }

  /**
   * Returns balance in DASH from cache, if it's up to date. If not, makes an API request and updates cached data.
   * @override
   * @returns {Number} or outdated cached value, if unable to fetch data; it may be undefined also
   */
  async getBalance() {
    try {

      let cached = this.cache.getData('balance', true);
      if (cached) { // balance is a duffs string or number
        return this.fromSat(cached);
      }
      let balance = await requestDash('getaddressbalance', [this.address]);
      if (balance && balance.balance) {
        balance = balance.balance;
        this.cache.cacheData('balance', balance);
        return this.fromSat(balance);
      } else {
        log.warn(`Failed to get balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module; returning outdated cached balance. ${account.errorMessage}.`);
        return this.fromSat(this.cache.getData('balance', false));
      }

    } catch (e) {
      log.warn(`Error while getting balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Returns balance in DASH from cache. It may be outdated.
   * @override
   * @returns {Number} cached value; it may be undefined
   */
  get balance() {
    try {
      return this.fromSat(this.cache.getData('balance', false));
    } catch (e) {
      log.warn(`Error while getting balance in balance() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Updates DASH balance in cache. Useful when we don't want to wait for network update.
   * @override
   * @param {Number} value New balance in DASH
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
   * Returns last block of DASH blockchain from cache, if it's up to date. If not, makes an API request and updates cached data.
   * Used only for this.getLastBlockHeight()
   * @override
   * @returns {Object} or undefined, if unable to get block info
   */
  getLastBlock() {
    let cached = this.cache.getData('lastBlock', true);
    if (cached) {
      return cached;
    }
    return requestDash('getblockcount').then(result => {
      if (utils.isPositiveNumber(result)) {
        this.cache.cacheData('lastBlock', result);
        return result
      } else {
        log.warn(`Failed to get last block in getLastBlock() of ${utils.getModuleName(module.id)} module. Received value: ` + result);
      }
    })
  }

  /**
   * Returns last block height of DASH blockchain
   * @override
   * @returns {Number} or undefined, if unable to get block info
   */
  async getLastBlockHeight() {
    const block = await this.getLastBlock();
    return block ? block : undefined;
  }

  /**
   * Returns Tx status and details from the blockchain
   * @override
   * @param {String} txid Tx ID to fetch
   * @returns {Object}
   * Used for income Tx security validation (deepExchangeValidator): senderId, recipientId, amount, timestamp
   * Used for checking income Tx status (confirmationsCounter), exchange and send-back Tx status (sentTxChecker): status, confirmations || height
   * Not used, additional info: hash (already known), blockId, fee, recipients, senders
   */
  async getTransaction(txid) {
    return requestDash('getrawtransaction', [txid, true]).then(result => {
      if (typeof result !== 'object') return undefined
      const formedTx = this._mapTransaction(result)
      log.log(`Tx status: ${this.formTxMessage(formedTx)}.`);
      return formedTx
    })
  }

  /**
   * Retrieves unspents (UTXO)
   * @override
   * @returns {Promise<Array<{txid: string, vout: number, amount: number}>>} or undefined
   */
  getUnspents() {
    const params = [this.address];
    return requestDash('getaddressutxos', params).then(result => {
      if (!Array.isArray(result)) return undefined
      return result.map(tx => ({
        txid: tx.txid,
        amount: tx.satoshis,
        vout: tx.outputIndex
      }))
    })
  }

};

/**
 * Makes a POST request to Dash node. Internal function.
 * @param {string} method Endpoint name
 * @param {*} params Endpoint params
 * @returns {*} Request results or undefined
 */
function requestDash(method, params) {
  return axios.post(dashNode, { method, params })
    .then(response => {
      response = formatRequestResults(response, true);
      if (response.success) {
        return response.data.result;
      } else {
        log.warn(`Request to ${method} RPC returned an error: ${response.errorMessage}.`);
      }
    })
    .catch(function (error) {
      log.warn(`Request to ${method} RPC in ${utils.getModuleName(module.id)} module failed. ${formatRequestResults(error, false).errorMessage}.`);
    });
}

/**
 * Formats axios request results. Internal function.
 * @param {object} response Axios response
 * @param {boolean} isRequestSuccess If axios request succeed
 * @returns {object} Formatted request results
 */
function formatRequestResults(response, isRequestSuccess) {

  let results = {};
  results.details = {};

  if (isRequestSuccess) {
    results.success = response.data && !response.data.error;
    results.data = response.data;
    results.details.status = response.status;
    results.details.statusText = response.statusText;
    results.details.response = response;
    if (!results.success && results.data)
      results.errorMessage = `Node's reply: ${results.data.error}`
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
