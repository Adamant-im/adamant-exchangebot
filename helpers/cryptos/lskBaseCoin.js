const baseCoin = require('./baseCoin');
const config = require('../../modules/configReader');
const axios = require('axios');
const transactions = require('@liskhq/lisk-transactions');
const cryptography = require('@liskhq/lisk-cryptography');
const log = require('../log');
const api = require('../../modules/api');
const utils = require('../utils');
const constants = require('../const');

const lskNode = config.node_LSK[0]; // TODO: health check
const lskService = config.service_LSK[0];

module.exports = class LskBaseCoin extends baseCoin {
  constructor(token) {
    super();
    this.token = token;
    this.account.keys = api[token.toLowerCase()].keys(config.passPhrase);
    this.account = Object.assign(this.account, this.account.keys);
    this.clients = {};

    this.cache.balance = { lifetime: 30000 };
    this.cache.lastBlock = { lifetime: 60000 };

    setTimeout(() => this.getBalance().then((balance) =>
      log.log(`Initial ${this.token} balance: ${utils.isPositiveOrZeroNumber(balance) ? balance.toFixed(constants.PRINT_DECIMALS) : 'unable to receive'}`),
    ), 1000);
    setTimeout(() => this.getLastBlockHeight().then((lastBlockHeight) =>
      log.log(`Last ${this.token} block height: ${utils.isPositiveOrZeroNumber(lastBlockHeight) ? lastBlockHeight : 'unable to receive'}`),
    ), 1000);
  }

  /**
   * Converts amount in beddows to token
   * @param {String|Number} satValue Amount in beddows
   * @return {Number} Amount in coins
   */
  fromBeddows(satValue) {
    try {
      const value = (+satValue / this.multiplier).toFixed(this.decimals);
      return +value;
    } catch (e) {
      log.warn(`Error while converting fromBeddows(${satValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Converts amount in token to beddows
   * @param {String|Number} tokenValue Amount in coins
   * @return {Number} Amount in beddows
   */
  toBeddows(tokenValue) {
    try {
      return Math.floor(+tokenValue * this.multiplier);
    } catch (e) {
      log.warn(`Error while converting toBeddows(${tokenValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Make get request to LSK node
   * @param {string} url request url
   * @param {object} params url parameters
   * @return {Object}
   */
  _get(url, params) {
    return this._getClient().get(url, { params }).then((response) => response.data);
  }

  /**
   * Make get request to Lisk service
   * @param {string} url request url
   * @param {object} params url parameters
   * @return {Object}
   */
  _getService(url, params) {
    return this._getServiceClient().get(url, { params }).then((response) => response.data);
  }

  /**
   * Get client for a random LSK node
   * @return {Object} Axios client
   */
  _getClient() {
    if (!this.clients[lskNode]) {
      this.clients[lskNode] = createClient(lskNode);
    }
    return this.clients[lskNode];
  }

  /**
   * Get client for a random API Lisk service node
   * @return {Object} Axios client
   */
  _getServiceClient() {
    if (!this.clients[lskService]) {
      this.clients[lskService] = createServiceClient(lskService);
    }
    return this.clients[lskService];
  }

  /**
   * Formats LSK Tx info
   * @param {object} tx Tx
   * @return {object} Formatted Tx info
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
   * Builds log message from formed Tx
   * @param {object} tx Tx
   * @return {string | object} Log message
   */
  formTxMessage(tx) {
    try {
      const token = this.token;
      const status = tx.status ? ' is accepted' : tx.status === false ? ' is FAILED' : '';
      const amount = tx.amount ? ` for ${tx.amount} ${token}` : '';
      const height = tx.height ? `${status ? ' and' : ' is'} included at ${tx.height} blockchain height` : '';
      const confirmations = tx.confirmations ? ` and has ${tx.confirmations} confirmations` : '';
      const instantSend = !height && !confirmations && tx.instantlock && tx.instantlock_internal ? `${status ? ' and' : ' is'} locked with InstantSend` : '';
      const time = tx.timestamp ? ` (${utils.formatDate(tx.timestamp).YYYY_MM_DD_hh_mm} — ${tx.timestamp})` : '';
      const hash = tx.hash;
      const fee = tx.fee || tx.fee === 0 ? `, ${tx.fee} ${token} fee` : '';
      const senderId = utils.isStringEqualCI(tx.senderId, this.account.address) ? 'Me' : tx.senderId;
      const recipientId = utils.isStringEqualCI(tx.recipientId, this.account.address) ? 'Me' : tx.recipientId;
      return `Tx ${hash}${amount} from ${senderId} to ${recipientId}${status}${instantSend}${height}${time}${confirmations}${fee}`;
    } catch (e) {
      log.warn(`Error while building Tx ${tx ? tx.id : undefined} message for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
      return tx;
    }
  }
};

/**
 * Create axios client to Lisk service
 * @param {string} url client base url
 * @return {Object}
 */
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

/**
 * Create axios client to Lisk node
 * @param {string} url client base url
 * @return {Object}
 */
function createClient(url) {
  const client = axios.create({ baseURL: url });
  client.interceptors.response.use(null, (error) => {
    if (error.response && Number(error.response.status) >= 500) {
      console.error(`Request to ${url} failed.`, error);
    }
    if (error.response && Number(error.response.status) === 404) {
      if (error.response.data && error.response.data.errors && error.response.data.errors[0] && error.response.data.errors[0].message && error.response.data.errors[0].message.includes('was not found')) {
        return error.response;
      }
    }
    return Promise.reject(error);
  });
  return client;
}

