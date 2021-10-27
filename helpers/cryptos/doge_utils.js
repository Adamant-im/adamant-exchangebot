const config = require('../../modules/configReader');
const log = require('../log');
const utils = require('../utils');

const dogeNode = config.node_DOGE[0]; // TODO: health check
const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');

const btcBaseCoin = require('./btcBaseCoin');
module.exports = class dogeCoin extends btcBaseCoin {

  constructor(token) {
    super(token);
    this.cache.balance = { lifetime: 30000 };
    this.cache.lastBlock = { lifetime: 60000 };
  }

  /**
   * Returns DOGE decimals (precision)
   * @override
   * @return {Number}
   */
  get decimals() {
    return 8;
  }

  /**
   * Returns fixed tx fee
   * @return {Number}
   */
  get FEE() {
    return 1;
  }

  /**
   * Returns balance in DOGE from cache, if it's up to date. If not, makes an API request and updates cached data.
   * @override
   * @return {Number} or outdated cached value, if unable to fetch data; it may be undefined also
   */
  async getBalance() {
    try {

      const cached = this.cache.getData('balance', true);
      if (cached) { // balance is a number in sat
        return this.fromSat(cached);
      }

      const balance = await requestDoge(`/api/addr/${this.address}/balance`);
      if (balance !== undefined) {
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
   * Returns balance in DOGE from cache. It may be outdated.
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
   * Updates DOGE balance in cache. Useful when we don't want to wait for network update.
   * @override
   * @param {Number} value New balance in DOGE
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
   * Returns last block of DOGE blockchain from cache, if it's up to date.
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
    return requestDoge('/api/status').then((result) => {
      if (result && result.info && utils.isPositiveNumber(result.info.blocks)) {
        this.cache.cacheData('lastBlock', result.info.blocks);
        return result.info.blocks;
      } else {
        log.warn(`Failed to get last block in getLastBlock() of ${utils.getModuleName(module.id)} module. Received value: ` + result);
      }
    });
  }

  /**
   * Returns last block height of DOGE blockchain
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
    return requestDoge(`/api/tx/${txid}`).then((result) => {

      if (typeof result !== 'object') return undefined;
      const formedTx = this._mapTransaction(result);
      if (!disableLogging) log.log(`${this.token} tx status: ${this.formTxMessage(formedTx)}.`);
      return formedTx;
    });
  }

  /**
   * Retrieves unspents (UTXO)
   * It's for bitcoinjs-lib's deprecated TransactionBuilder
   * We don't use Psbt as it needs full tx hexes, and we don't know how to get them
   * @override
   * @return {Promise<Array<{txid: string, vout: number, amount: number}>>} or undefined
   */
  getUnspents() {
    return requestDoge(`/api/addr/${this.address}/utxo?noCache=1`).then((outputs) =>
      outputs.map((tx) => ({
        ...tx,
        amount: this.toSat(tx.amount),
      })),
    );
  }

  /**
   * Creates a raw BTC-based transaction as a hex string.
   * We override base method, as it uses Psbt
   * We don't use Psbt as it needs full tx hexes, and we don't know how to get them
   * @override
   * @param {string} address target address
   * @param {number} amount amount to send
   * @param {Array<{txid: string, amount: number, vout: number}>} unspents unspent transaction to use as inputs
   * @param {number} fee transaction fee in DOGE
   * @return {string}
   */
  _buildTransaction(address, amount, unspents, fee) {
    try {
      const amountInSat = this.toSat(amount);
      const target = amountInSat + this.toSat(fee);
      const txb = new bitcoin.TransactionBuilder(this.account.network);
      txb.setVersion(1);

      let transferAmount = 0;
      let inputs = 0;
      unspents.forEach((tx) => {
        const amt = Math.floor(tx.amount);
        if (transferAmount < target) {
          txb.addInput(tx.txid, tx.vout);
          transferAmount += amt;
          inputs++;
        }
      });

      txb.addOutput(bitcoin.address.toOutputScript(address, this.account.network), amountInSat);
      // This is a necessary step
      // If we'll not add a change to output, it will burn in hell
      const change = transferAmount - target;
      if (utils.isPositiveNumber(change)) {
        txb.addOutput(this.address, change);
      }

      for (let i = 0; i < inputs; ++i) {
        txb.sign(i, this.account.keyPair);
      }

      return txb.build().toHex();
    } catch (e) {
      log.warn(`Error while building Tx to send ${amount} ${this.token} to ${address} with ${fee} ${this.token} fee in _buildTransaction() of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Broadcasts the specified transaction to the DOGE network
   * @override
   * @param {string} txHex raw transaction as a HEX literal
   */
  sendTransaction(txHex) {
    return requestDoge('/api/tx/send', { rawtx: txHex }).then((data) => {
      return data.txid;
    });
  }

};

/**
 * Makes a GET request to Doge node. Internal function.
 * @param {string} endpoint Endpoint name
 * @param {*} params Endpoint params
 * @return {*} Request results or undefined
 */
function requestDoge(endpoint, params) {
  const httpOptions = {
    url: dogeNode + endpoint,
    method: params ? 'post' : 'get', // Only post requests to Doge node have params
    data: params,
  };

  return axios(httpOptions)
      .then((response) => {
        response = formatRequestResults(response, true);
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
    results.success = (response.data !== undefined) && !response.data.error;
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
