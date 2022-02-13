const btcBaseCoin = require('./btcBaseCoin');
const config = require('../../modules/configReader');
const axios = require('axios');
const { transactions, cryptography } = require('lisk-sdk');

const lskNode = config.node_LSK[0]; // TODO: health check
const lskService = config.service_LSK[0];

module.exports = class LskBaseCoin extends btcBaseCoin {
  constructor(token) {
    super('LSK');
    this.token = token;
    this.clients = {};

    this.cache.balance = { lifetime: 30000 };
    this.cache.lastBlock = { lifetime: 60000 };
    this.account.addressHex = this.account.keys.addressHex;
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

