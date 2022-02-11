const config = require('../../modules/configReader');
const log = require('../log');
const axios = require('axios');
const btcBaseCoin = require('./btcBaseCoin');
const utils = require('../utils');
const { transactions, cryptography } = require('lisk-sdk');

const lskNode = config.node_LSK[0]; // TODO: health check
const lskService = config.service_LSK[0];

module.exports = class lskCoin extends btcBaseCoin {
  constructor(token) {
    super('LSK');
    this.token = token;
    this.clients = {};

    this.cache.balance = { lifetime: 30000 };
    this.cache.lastBlock = { lifetime: 60000 };
    this.account.addressHex = this.account.keys.addressHex;
  }

  /**
   * Returns DASH decimals (precision)
   * @override
   * @return {Number}
   */
  get decimals() {
    return 8;
  }

  /**
   * Returns fixed fee for transfers
   * @return {Number}
   */
  get FEE() {
    return 0.00160;
  }

  get multiplier() {
    return 1e8;
  }

  _get(url, params) {
    return this._getClient().get(url, { params }).then((response) => response.data);
  }

  _getService(url, params) {
    return this._getServiceClient().get(url, { params }).then((response) => response.data);
  }

  _getClient() {
    if (!this.clients[lskNode]) {
      this.clients[lskNode] = createClient(lskNode);
    }
    return this.clients[lskNode];
  }

  _getServiceClient() {
    if (!this.clients[lskService]) {
      this.clients[lskService] = createServiceClient(lskService);
    }
    return this.clients[lskService];
  }

  getHeight() {
    return this._get(`${lskNode}/api/node/info`).then(
        (data) => {
          return Number(data.data.height) || 0;
        });
  }

  /**
   * Returns last block of DOGE blockchain from cache, if it's up to date.
   * If not, makes an API request and updates cached data.
   * Used only for this.getLastBlockHeight()
   * @override
   * @return {Object} or undefined, if unable to get block info
   */
  async getLastBlock() {
    const cached = this.cache.getData('lastBlock', true);
    if (cached) {
      return cached;
    }
    const height = await this.getHeight();
    if (height) {
      this.cache.cacheData('lastBlock', height);
      return height;
    } else {
      log.warn(`Failed to get last block in getLastBlock() of ${utils.getModuleName(module.id)} module. Received value: ` + response);
    }
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
   * Returns balance in DASH from cache, if it's up to date. If not, makes an API request and updates cached data.
   * @override
   * @return {Number} or outdated cached value, if unable to fetch data; it may be undefined also
   */
  async getBalance() {
    try {
      const cached = this.cache.getData('balance', true);
      if (cached) { // balance is a duffs string or number
        return this.fromSat(cached);
      }
      const result = await this._get(`${lskNode}/api/accounts/${this.account.addressHex}`, {});
      if (result && result.data && (result.data.token.balance !== undefined)) {
        const balance = result.data.token.balance;
        this.cache.cacheData('balance', balance);
        return this.fromSat(balance);
      } else {
        const balanceErrorMessage = result && result.errorMessage ? ' ' + result.errorMessage : '';
        log.warn(`Failed to get balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module; returning outdated cached balance.${balanceErrorMessage}`);
        return this.fromSat(this.cache.getData('balance', false));
      }

    } catch (e) {
      log.warn(`Error while getting balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Returns balance in LSK from cache. It may be outdated.
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
   * Updates LSK balance in cache. Useful when we don't want to wait for network update.
   * @override
   * @param {Number} value New balance in LSK
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
   * Updates LSK balance in cache. Useful when we don't want to wait for network update.
   * @override
   * @param {object} tx LSK transaction
   * @return {object}
   */
  _mapTransaction(tx) {
    const direction = tx.sender.address.toUpperCase() === this.account.address.toUpperCase() ? 'from' : 'to';

    const mapped = {
      id: tx.id,
      hash: tx.id,
      fee: tx.fee,
      status: tx.height ? 'CONFIRMED' : 'REGISTERED',
      data: tx.asset.data,
      timestamp: tx.block.timestamp,
      direction,
      senderId: tx.sender.address,
      recipientId: tx.asset.recipient.address,
      amount: tx.asset.amount,
      confirmations: tx.confirmations,
      height: tx.height,
      nonce: tx.nonce,
      moduleId: tx.moduleAssetId.split(':')[0],
      assetId: tx.moduleAssetId.split(':')[1],
      moduleName: tx.moduleAssetName.split(':')[0],
      assetName: tx.moduleAssetName.split(':')[1],
    };

    mapped.amount /= this.multiplier;
    mapped.fee /= this.multiplier;
    mapped.timestamp = parseInt(mapped.timestamp) * 1000; // timestamp in millis

    return mapped;
  }

  /** @override */
  sendTransaction(signedTx) {
    return this._getClient().post('/api/transactions', signedTx).then((response) => {
      return response.data.data.transactionId;
    });
  }

  get assetSchema() {
    return {
      $id: 'lisk/transfer-asset',
      title: 'Transfer transaction asset',
      type: 'object',
      required: ['amount', 'recipientAddress', 'data'],
      properties: {
        amount: {
          dataType: 'uint64',
          fieldNumber: 1,
        },
        recipientAddress: {
          dataType: 'bytes',
          fieldNumber: 2,
          minLength: 20,
          maxLength: 20,
        },
        data: {
          dataType: 'string',
          fieldNumber: 3,
          minLength: 0,
          maxLength: 64,
        },
      },
    };
  }

  /**
   * Creates an LSK-based transaction as an object with specific types
   * @param {string} address Target address
   * @param {number} amount to send (coins, not satoshis)
   * @param {number} fee fee of transaction
   * @param {number} nonce nonce value
   * @param {string} data New balance in LSK
   * @return {object}
   */
  _buildTransaction(address, amount, fee, nonce, data = '') {
    const amountString = transactions.convertLSKToBeddows((+amount).toFixed(this.decimals));
    const feeString = transactions.convertLSKToBeddows((+fee).toFixed(this.decimals));
    const nonceString = nonce.toString();
    const liskTx = {
      moduleID: this.moduleId,
      assetID: this.assetId,
      nonce: BigInt(nonceString),
      fee: BigInt(feeString),
      asset: {
        amount: BigInt(amountString),
        recipientAddress: cryptography.getAddressFromBase32Address(address),
        data,
        // data: 'Sent with ADAMANT Messenger'
      },
      signatures: [],
    };
    liskTx.senderPublicKey = this.account.keyPair.publicKey;
    const minFee = Number(transactions.computeMinFee(this.assetSchema, liskTx)) / this.multiplier;

    return { liskTx, minFee };
  }
  /**
   * Returns Tx status and details from the blockchain
   * @override
   * @param {String} txid Tx ID to fetch
   * @param {Boolean}disableLogging
   * @return {Object}
   * Used for income Tx security validation (deepExchangeValidator): senderId, recipientId, amount, timestamp
   * Used for checking income Tx status (confirmationsCounter), exchange and send-back Tx status (sentTxChecker):
   * status, confirmations || height
   * Not used, additional info: hash (already known), blockId, fee, recipients, senders
   */
  async getTransaction(txid, disableLogging = false) {
    return this._getService(`${lskService}/api/v2/transactions/`, { transactionId: txid }).then((result) => {
      if (typeof result !== 'object') return undefined;
      if (result && result.data[0]) {
        const formedTx = this._mapTransaction(result.data[0]);
        if (!disableLogging) log.log(`${this.token} tx status: ${this.formTxMessage(formedTx)}.`);
        return formedTx;
      }
    });
  }
};

function createServiceClient(url) {
  const client = axios.create({ baseURL: url });
  client.interceptors.response.use(null, (error) => {
    if (error.response && Number(error.response.status) >= 500) {
      console.error(`Request to ${url} failed.`, error);
    }
    return Promise.reject(error);
  });
  return client;
}

function createClient(url) {
  const client = axios.create({ baseURL: url });
  client.interceptors.response.use(null, (error) => {
    if (error.response && Number(error.response.status) >= 500) {
      console.error(`Request to ${url} failed.`, error);
    }
    // Lisk is spamming with 404 in console, when there is no LSK account
    // There is no way to disable 404 logging for Chrome
    if (error.response && Number(error.response.status) === 404) {
      if (error.response.data && error.response.data.errors && error.response.data.errors[0] && error.response.data.errors[0].message && error.response.data.errors[0].message.includes('was not found')) {
        return error.response;
      }
    }
    return Promise.reject(error);
  });
  return client;
}
