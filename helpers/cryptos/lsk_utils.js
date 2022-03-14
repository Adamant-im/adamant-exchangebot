const config = require('../../modules/configReader');
const log = require('../log');
const LskBaseCoin = require('./lskBaseCoin');
const utils = require('../utils');
const { transactions, cryptography } = require('lisk-sdk');

const lskNode = config.node_LSK[0]; // TODO: health check
const lskService = config.service_LSK[0];

module.exports = class lskCoin extends LskBaseCoin {
  constructor(token) {
    super(token);
  }

  /**
   * Returns LSK decimals (precision)
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

  /**
   * Get asset Id
   * @return {number}
   */
  get assetId() {
    return 0;
  }
  /**
   * Get Token/Send module Id
   * @return {number}
   */
  get moduleId() {
    return 2;
  }
  get networkIdentifier() {
    // Testnet: '15f0dacc1060e91818224a94286b13aa04279c640bd5d6f193182031d133df7c'
    // Mainnet: '4c09e6a781fc4c7bdb936ee815de8f94190f8a7519becd9de2081832be309a99'
    const networkIdentifier = '4c09e6a781fc4c7bdb936ee815de8f94190f8a7519becd9de2081832be309a99';
    return Buffer.from(networkIdentifier, 'hex');
  }
  getHeight() {
    return this._get(`${lskNode}/api/node/info`).then(
        (data) => {
          return Number(data.data.height) || 0;
        });
  }
  /**
   * Returns last block of LSK blockchain from cache, if it's up to date.
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
   * Returns last block height of LSK blockchain
   * @override
   * @return {Number} or undefined, if unable to get block info
   */
  async getLastBlockHeight() {
    const block = await this.getLastBlock();
    return block ? block : undefined;
  }

  /**
   * Returns balance in LSK from cache, if it's up to date. If not, makes an API request and updates cached data.
   * @override
   * @return {Number} or outdated cached value, if unable to fetch data; it may be undefined also
   */
  async getBalance() {
    try {
      const cached = this.cache.getData('balance', true);
      if (cached) { // balance is a beddows string or number
        return this.fromBeddows(cached);
      }
      const result = await this._get(`${lskNode}/api/accounts/${this.account.addressHex}`, {});
      if (result && result.data && (result.data.token.balance !== undefined)) {
        const balance = result.data.token.balance;
        this.cache.cacheData('balance', balance);
        return this.fromBeddows(balance);
      } else {
        const balanceErrorMessage = result && result.errorMessage ? ' ' + result.errorMessage : '';
        log.warn(`Failed to get balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module; returning outdated cached balance.${balanceErrorMessage}`);
        return this.fromBeddows(this.cache.getData('balance', false));
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
      return this.fromBeddows(this.cache.getData('balance', false));
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
        this.cache.cacheData('balance', this.toBeddows(value));
      }
    } catch (e) {
      log.warn(`Error setting balance in balance() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Send signed transaction to blockchain network
   * @override
   * @param {Object} signedTx
   */
  sendTransaction(signedTx) {
    return this._getClient().post('/api/transactions', signedTx).then((response) => {
      return response.data.data.transactionId;
    });
  }

  /**
   * Asset schema defines in which format data is sent in the transaction asset
   */
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
   * Build Tx and broadcasts it
   * @abstract
   * @param {object} params try: try number, address: recipient's address, value: amount to send in coins (not satoshis)
   */
  async send(params) {
    let fee = this.FEE;
    try {
      const account = await this._get(`${lskNode}/api/accounts/${this.account.addressHex}`, {});
      const nonce = Number(account.data.sequence.nonce);
      fee = this._buildTransaction(params.address, params.value, fee, nonce).minFee;
      const result = await this.createTransaction(params.address, params.value, fee, nonce);
      try {
        if (result) {
          log.log(`Successfully built Tx ${result.txId} to send ${params.value} ${this.token} to ${params.address} with ${fee} ${this.token} fee.`);
          const hash = await this.sendTransaction(result.tx);
          try {
            if (hash) {
              log.log(`Successfully broadcasted Tx to send ${params.value} ${this.token} to ${params.address} with ${fee} ${this.token} fee, Tx hash: ${hash}.`);
              return {
                success: true,
                hash,
              };
            }
            return {
              success: false,
              error: `Unable to broadcast Tx, it may be dust amount or other error`,
            };
          } catch (e) {
            return {
              success: false,
              error: e.toString(),
            };
          }
        }
        return {
          success: false,
          error: `Unable to create Tx`,
        };
      } catch (e) {
        return {
          success: false,
          error: e.toString(),
        };
      }
    } catch (e) {
      log.warn(`Error while sending ${params.value} ${this.token} to ${params.address} with ${fee} ${this.token} fee in send() of ${utils.getModuleName(module.id)} module: ` + e);
      return {
        success: false, error: e.toString(),
      };
    }
  }

  /**
   * Creates a signed tx object and ID
   * Signed JSON tx object is ready for broadcasting to blockchain network
   * @override
   * @param {string} address receiver address in Base32 format
   * @param {number} amount amount to transfer (coins, not beddows)
   * @param {number} fee transaction fee (coins, not beddows)
   * @param {number} nonce transaction nonce
   * @return {Promise<{tx: Object, txId: string}>}
   */
  createTransaction(address = '', amount = 0, fee, nonce, data = '') {
    const { liskTx } = this._buildTransaction(address, amount, fee, nonce, data);
    // To use transactions.signTransaction, passPhrase is necessary
    // So we'll use cryptography.signDataWithPrivateKey
    const liskTxBytes = transactions.getSigningBytes(this.assetSchema, liskTx);
    const txSignature = cryptography.signDataWithPrivateKey(
        Buffer.concat([this.networkIdentifier, liskTxBytes]), this.account.keyPair.secretKey,
    );

    liskTx.signatures[0] = txSignature;
    const txId = utils.bytesToHex(cryptography.hash(transactions.getBytes(this.assetSchema, liskTx)));

    // To send Tx to node's core API, we should change data types
    liskTx.senderPublicKey = utils.bytesToHex(liskTx.senderPublicKey);
    liskTx.nonce = nonce.toString();
    liskTx.fee = transactions.convertLSKToBeddows((+fee).toFixed(this.decimals));
    liskTx.asset.amount = transactions.convertLSKToBeddows((+amount).toFixed(this.decimals));
    liskTx.asset.recipientAddress = utils.bytesToHex(liskTx.asset.recipientAddress);
    liskTx.signatures[0] = utils.bytesToHex(txSignature);
    return Promise.resolve({ tx: liskTx, txId });
  }

  /**
   * Returns Tx status and details from the blockchain
   * @override
   * @param {String} txid Tx ID to fetch
   * @param {Boolean}disableLogging Disable logging flag
   * @return {Object} Formed tx
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
