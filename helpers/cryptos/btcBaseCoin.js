const config = require('../../modules/configReader');
const log = require('../log');
const api = require('../../modules/api');
const constants = require('../const');
const utils = require('../utils');

const bitcoin = require('bitcoinjs-lib'); // as in adamant-api

const baseCoin = require('./baseCoin');
module.exports = class btcBaseCoin extends baseCoin {

  constructor(token) {
    super();
    this.token = token;
    this.account.keys = api[token.toLowerCase()].keys(config.passPhrase);
    this.account.network = this.account.keys.network;
    this.account.keyPair = this.account.keys.keyPair;
    this.account.address = this.account.keys.address;
    this.account.privateKey = this.account.keys.privateKey;
    setTimeout(() => this.getBalance().then((balance) => log.log(`Initial ${this.token} balance: ${utils.isPositiveOrZeroNumber(balance) ? balance.toFixed(constants.PRINT_DECIMALS) : 'unable to receive'}`)), 1000);
    setTimeout(() => this.getLastBlockHeight().then((lastBlockHeight) => log.log(`Last ${this.token} block height: ${utils.isPositiveOrZeroNumber(lastBlockHeight) ? lastBlockHeight : 'unable to receive'}`)), 1000);

    // setTimeout(() => this.getUnspents().then((unspends) => log.log(`Unspends for ${this.token}: ${unspends}`)), 1000);
    // setTimeout(() => this.getTransaction('48fa6e3f93adf74dfa1256a6846090e8ef7a95a8fe70ee6d13c6c1b3861cd8e2'), 1000);
    //    .then((tx) => log.log(`Last ${this.token} block height:
    //        ${utils.isPositiveOrZeroNumber(tx) ? tx : 'unable to receive'}`)), 1000);
  }

  /**
   * Returns coin decimals (precision)
   * @abstract
   * @return {Number}
   */
  get decimals() {
    return undefined;
  }

  /**
   * Returns multiplier for sats
   * @return {Number}
   */
  get multiplier() {
    return Math.pow(10, this.decimals);
  }

  /**
   * Returns wallet address
   * @return {String}
   */
  get address() {
    return this.account.address;
  }

  /**
   * Converts amount in sat to token
   * @param {String|Number} satValue Amount in sat
   * @return {Number} Amount in coins
   */
  fromSat(satValue) {
    try {
      const value = (+satValue / this.multiplier).toFixed(this.decimals);
      return +value;
    } catch (e) {
      log.warn(`Error while converting fromSat(${satValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Converts amount in token to sat
   * @param {String|Number} tokenValue Amount in coins
   * @return {Number} Amount in sat
   */
  toSat(tokenValue) {
    try {
      return Math.floor(+tokenValue * this.multiplier);
    } catch (e) {
      log.warn(`Error while converting toSat(${tokenValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Returns transfer Tx fee
   * @abstract
   * @return {Number}
   */
  get FEE() {
    return 0;
  }

  /**
   * Returns last block of token blockchain from cache, if it's up to date.
   * If not, makes an API request and updates cached data.
   * Used only for this.getLastBlockHeight()
   * @abstract
   * @return {Object} or undefined, if unable to get block info
   */
  getLastBlock() {
    return undefined;
  }

  /**
   * Returns last block height of token blockchain
   * @abstract
   * @return {Number} or undefined, if unable to get block info
   */
  async getLastBlockHeight() {
    return undefined;
  }

  /**
   * Returns balance in coins (not satoshis) from cache, if it's up to date.
   * If not, makes an API request and updates cached data.
   * @abstract
   * @return {Number} or outdated cached value, if unable to fetch data; it may be undefined also
   */
  async getBalance() {
    return undefined;
  }

  /**
   * Returns balance in coins (not satoshis) from cache. It may be outdated.
   * @abstract
   * @return {Number} cached value; it may be undefined
   */
  get balance() {
    return undefined;
  }

  /**
   * Updates coin balance in cache. Useful when we don't want to wait for network update.
   * @abstract
   * @param {Number} value New balance (in coin, not satoshis)
   */
  set balance(value) {
  }

  /**
   * Returns block details from the blockchain
   * @param {String} blockId Block ID to fetch
   * @abstract
   * @return {Object}
   * Internal use. Not needed for some coins.
   */
  getBlock(blockId) {
    return {};
  }

  /**
   * Returns Tx status and details from the blockchain
   * @abstract
   * @param {String} txid Tx ID to fetch
   * @return {Object}
   * Used for income Tx security validation (deepExchangeValidator): senderId, recipientId, amount, timestamp
   * Used for checking income Tx status (confirmationsCounter), exchange and send-back Tx status (sentTxChecker):
   * status, confirmations || height
   * Not used, additional info: hash (already known), blockId, fee, recipients, senders
   */
  async getTransaction(txid) {
    return {};
  }

  /**
   * Retrieves unspents (UTXO)
   * @abstract
   * @return {Promise<Array<{txid: string, vout: number, amount: number}>>}
   */
  getUnspents() {
    return Promise.resolve([]);
  }

  /**
   * Creates a transfer transaction hex (raw Tx) and ID
   * @param {string} address receiver address
   * @param {number} amount amount to transfer (coins, not satoshis)
   * @param {number} fee transaction fee (coins, not satoshis)
   * @return {Promise<{hex: string, txid: string}>}
   */
  createTransaction(address = '', amount = 0, fee) {
    return this.getUnspents().then((unspents) => {
      if (unspents) {
        const hex = this._buildTransaction(address, amount, unspents, fee);
        let txid = bitcoin.crypto.sha256(Buffer.from(hex, 'hex'));
        txid = bitcoin.crypto.sha256(Buffer.from(txid));
        txid = txid.toString('hex').match(/.{2}/g).reverse().join('');
        return { hex, txid };
      }
    });
  }

  /**
   * Creates a raw transaction as a hex string
   * @param {string} address Target address
   * @param {number} amount Amount to send (coins, not satoshis)
   * @param {Array<{txid: string, amount: number, vout: number}>} unspents Unspent transactions to use as inputs
   * @param {number} fee Transaction fee in primary units (BTC, DOGE, DASH, etc)
   * @return {string} Raw transaction as a hex string
   */
  _buildTransaction(address, amount, unspents, fee) {

    try {
      const amountInSat = this.toSat(amount);
      const psbt = new bitcoin.Psbt({ network: this.account.network }); // bitcoin.TransactionBuilder is deprecated, so we use psbt
      const target = amountInSat + this.toSat(fee);
      let transferAmount = 0;
      unspents.forEach((tx) => {
        const amt = Math.floor(tx.amount);
        if (transferAmount < target) {
          psbt.addInput(tx);
          transferAmount += amt;
        }
      });
      psbt.addOutput({ script: bitcoin.address.toOutputScript(address, this.account.network), value: amountInSat });
      // This is a necessary step
      // If we'll not add a change to output, it will burn in hell
      const change = transferAmount - target;
      if (utils.isPositiveNumber(change)) {
        psbt.addOutput({ address: this.address, value: change });
      }
      psbt.signAllInputs(this.account.keyPair);
      psbt.finalizeAllInputs();
      const txHex = psbt.extractTransaction().toHex();
      return txHex;

    } catch (e) {
      log.warn(`Error while building Tx to send ${amount} ${this.token} to ${address} with ${fee} ${this.token} fee in _buildTransaction() of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Broadcasts the specified transaction to the network
   * @abstract
   * @param {string} txHex Raw transaction as a HEX literal
   * @return {Promise<Object>} Tx id
   */
  sendTransaction(txHex) {
    return Promise.resolve('');
  }

  /**
   * Build Tx and broadcasts it
   * @abstract
   * @param {object} params try: try number, address: recipient's address, value: amount to send in coins (not satoshis)
   */
  async send(params) {
    let fee = 0;
    try {
      fee = this.FEE;
      return this.createTransaction(params.address, params.value, fee)
          .then((result) => {
            if (result) {
              log.log(`Successfully built Tx ${result.txid} to send ${params.value} ${this.token} to ${params.address} with ${fee} ${this.token} fee: ${result.hex}.`);
              return this.sendTransaction(result.hex)
                  .then((hash) => {
                    if (hash) {
                      log.log(`Successfully broadcasted Tx to send ${params.value} ${this.token} to ${params.address} with ${fee} ${this.token} fee, Tx hash: ${hash}.`);
                      return {
                        success: true,
                        hash,
                      };
                    } else {
                      return {
                        success: false,
                        error: `Unable to broadcast Tx, it may be dust amount or other error`,
                      };
                    }
                  })
                  .catch((e) => {
                    return {
                      success: false,
                      error: e.toString(),
                    };
                  });
            } else {
              return {
                success: false,
                error: `Unable to create Tx hex, it may be no unspents retrieved`,
              };
            }
          })
          .catch((e) => {
            return {
              success: false,
              error: e.toString(),
            };
          });
    } catch (e) {
      log.warn(`Error while sending ${params.value} ${this.token} to ${params.address} with ${fee} ${this.token} fee in send() of ${utils.getModuleName(module.id)} module: ` + e);
      return {
        success: false,
        error: e.toString(),
      };
    }
  }

  /**
   * Formats Tx info
   * Coin implementations must modify results specifically
   * @param {object} tx Tx
   * @return {object} Formatted Tx info
   */
  _mapTransaction(tx) {
    try {

      const addressField = tx.vin[0].address ? 'address' : 'addr';
      const senders = utils.getUnique(tx.vin.map((input) => input[addressField])).filter((sender) => sender !== undefined && sender !== 'undefined');
      let recipients = utils.getUnique(tx.vout.reduce((list, out) => {
        list.push(...out.scriptPubKey.addresses);
        return list;
      }, [])).filter((sender) => sender !== undefined && sender !== 'undefined');

      let recipientId; let senderId;
      // In-chat transfers have one sender
      if (senders.length === 1) {
        senderId = senders[0];
      } else {
        senderId = `${senders.length} addresses`;
      }
      // In-chat transfers have 2 recipients: a recipient and a change to sender
      recipients = recipients.filter((recipient) => recipient !== senderId);
      if (recipients.length === 1) {
        recipientId = recipients[0];
      } else {
        recipientId = `${recipients.length} addresses`;
      }

      // Calculate amount from outputs (works only if 1 recipient, other way it returns 0):
      const amount = tx.vout.reduce((sum, t) =>
        (recipientId === t.scriptPubKey.addresses[0] ? sum + Number(t.value) : sum), 0).toFixed(this.decimals);

      const confirmations = tx.confirmations;
      const timestamp = tx.time ? tx.time * 1000 : undefined;
      let fee = tx.fees;
      if (!fee) {
        const totalIn = tx.vin.reduce((sum, x) => sum + (x.value ? +x.value : 0), 0);
        const totalOut = tx.vout.reduce((sum, x) => sum + (x.value ? +x.value : 0), 0);
        fee = (totalIn - totalOut).toFixed(this.decimals);
      }

      return {
        id: tx.txid,
        hash: tx.txid,
        blockId: tx.blockhash,
        fee: +fee, // in token, not satoshis
        status: confirmations > 0 ? true : undefined,
        timestamp,
        senders,
        senderId,
        recipients,
        recipientId,
        amount: +amount, // in token, not satoshis
        confirmations,
        height: tx.height,
        hex: tx.hex,
        instantlock: tx.instantlock,
        instantlock_internal: tx.instantlock_internal,
        chainlock: tx.chainlock,
      };

    } catch (e) {
      log.warn(`Error while formatting Tx ${tx ? tx.txid : undefined} for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
      return tx;
    }
  }

  /**
   * Builds log message from formed Tx
   * @param {object} tx Tx
   * @return {string} Log message
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
      const message = `Tx ${hash}${amount} from ${senderId} to ${recipientId}${status}${instantSend}${height}${time}${confirmations}${fee}`;
      return message;

    } catch (e) {
      log.warn(`Error while building Tx ${tx ? tx.id : undefined} message for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
      return tx;
    }
  }

};
