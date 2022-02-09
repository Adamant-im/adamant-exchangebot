const config = require('../../modules/configReader');
const log = require('../log');
const lskNode = config.node_LSK[0]; // TODO: health check
const axios = require('axios');
const btcBaseCoin = require('./btcBaseCoin');
const utils = require('../utils');


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

  _get(url, params) {
    return this._getClient().get(url, { params }).then((response) => response.data);
  }

  _getClient() {
    if (!this.clients[lskNode]) {
      this.clients[lskNode] = createClient(lskNode);
    }
    return this.clients[lskNode];
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
};

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
