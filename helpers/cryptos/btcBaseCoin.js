const config = require('../../modules/configReader');
const log = require('../log');
const api = require('../../modules/api');
const constants = require('../const');
const utils = require('../utils');

const bitcoin = require('bitcoinjs-lib'); // as in adamant-api

const baseCoin = require('./baseCoin');
module.exports = class btcBaseCoin extends baseCoin {

	constructor(token) {
		super()
		this.token = token;
    this.account.keys = api[token.toLowerCase()].keys(config.passPhrase);
    this.account.address = this.account.keys.address;
    this.account.privateKey = this.account.keys.privateKey;
		setTimeout(() => this.getBalance().then((balance) => log.log(`Initial ${this.token} balance: ${utils.isPositiveOrZeroNumber(balance) ? balance.toFixed(constants.PRINT_DECIMALS) : 'unable to receive'}`)), 1000);
	}

	/**
	 * Returns coin decimals (precision)
	 * @abstract
	 * @returns {Number}
	 */
	 get decimals () {
    return undefined
  }
	
	/**
	 * Returns multiplier for sats
	 * @returns {Number}
	 */
	get multiplier () {
    return Math.pow(10, this.decimals)
  }

	/**
	 * Returns wallet address
	 * @returns {String}
	 */
	get address () {
    return this.account.address
  }

	/**
	 * Converts amount in sat to token
	 * @param {String or Number} satValue
	 * @returns {Number}
	 */
	fromSat(satValue) {
		try {
			let value = (+satValue / this.multiplier).toFixed(this.decimals);
			return +value;
		} catch (e) {
			log.warn(`Error while converting fromSat(${satValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

	/**
	 * Converts amount in token to sat
	 * @param {String or Number} tokenValue
	 * @returns {Number}
	 */
	toSat(tokenValue) {
		try {
			return +tokenValue * this.multiplier
		} catch (e) {
			log.warn(`Error while converting toSat(${tokenValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

	/**
	 * Returns transfer Tx fee
	 * @abstract
	 * @returns {Number}
	 */
	get FEE() {
		return 0
	}

	/**
	 * Returns last block of token blockchain from cache, if it's up to date. If not, makes an API request and updates cached data.
	 * @abstract
	 * @returns {Object} or undefined, if unable to get block info
	 */
	getLastBlock() {
		return undefined
	}

	/**
	 * Returns last block height of token blockchain
	 * @abstract
	 * @returns {Number} or undefined, if unable to get block info
	 */
	async getLastBlockHeight() {
		return undefined;
	}

	/**
	 * Returns balance in Whole coins from cache, if it's up to date. If not, makes an API request and updates cached data.
	 * @abstract
	 * @returns {Number} or outdated cached value, if unable to fetch data; it may be undefined also
	 */
	async getBalance() {
		return undefined;
	}

	/**
	 * Returns balance in Whole coins from cache. It may be outdated.
	 * @abstract
	 * @returns {Number} cached value; it may be undefined
	 */
	get balance() {
		return undefined;
	}

	/**
	 * Updates ETH or ERC20 balance in cache. Useful when we don't want to wait for network update.
	 * @param {Number} value New balance in ETH or token
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
	 * Returns block details from the blockchain
	 * @param {String} blockId Block ID to fetch
	 * @abstract
	 * @returns {Object}
	 * Used for income Tx security validation (deepExchangeValidator): timestamp
	 * getBlock doesn't provide confirmations (calc it from height)
	 */
	getBlock(blockId) {
		return { }
	}

	/**
	 * Returns Tx status and details from the blockchain
	 * @param {String} txid Tx ID to fetch
	 * @returns {Object}
	 * Used for income Tx security validation (deepExchangeValidator): senderId, recipientId, amount, timestamp
	 * Used for checking income Tx status (confirmationsCounter), exchange and send-back Tx status (sentTxChecker): status, confirmations || height
	 * Not used, additional info: hash (already known), blockId, fee
	 */
	async getTransaction(txid) {
		return { }
	}

  /**
   * Retrieves unspents (UTXO)
   * @abstract
   * @returns {Promise<Array<{txid: string, vout: number, amount: number}>>}
   */
	 getUnspents () {
    return Promise.resolve([])
  }	

  /**
   * Creates a transfer transaction hex and ID
   * @param {string} address receiver address
   * @param {number} amount amount to transfer (coins, not satoshis)
   * @param {number} fee transaction fee (coins, not satoshis)
   * @returns {Promise<{hex: string, txid: string}>}
   */
	 createTransaction (address = '', amount = 0, fee) {
    return this.getUnspents().then(unspents => {
      const hex = this._buildTransaction(address, amount, unspents, fee)
      let txid = bitcoin.crypto.sha256(Buffer.from(hex, 'hex'))
      txid = bitcoin.crypto.sha256(Buffer.from(txid))
      txid = txid.toString('hex').match(/.{2}/g).reverse().join('')
      return { hex, txid }
    })
  }	

  /**
   * Creates a raw transaction as a hex string.
   * @param {string} address target address
   * @param {number} amount amount to send (coins, not satoshis)
   * @param {Array<{txid: string, amount: number, vout: number}>} unspents unspent transactions to use as inputs
   * @param {number} fee transaction fee in primary units (BTC, DOGE, DASH, etc)
   * @returns {string}
   */
	 _buildTransaction (address, amount, unspents, fee) {
    amount = new BigNumber(amount).times(this.multiplier).toNumber()
    amount = Math.floor(amount)

    const txb = new bitcoin.TransactionBuilder(this._network)
    txb.setVersion(1)

    const target = amount + new BigNumber(fee).times(this.multiplier).toNumber()
    let transferAmount = 0
    let inputs = 0

    unspents.forEach(tx => {
      const amt = Math.floor(tx.amount)
      if (transferAmount < target) {
        txb.addInput(tx.txid, tx.vout)
        transferAmount += amt
        inputs++
      }
    })

    txb.addOutput(bitcoin.address.toOutputScript(address, this._network), amount)
    txb.addOutput(this._address, transferAmount - target)

    for (let i = 0; i < inputs; ++i) {
      txb.sign(i, this._keyPair)
    }

    return txb.build().toHex()
  }

	/**
   * Broadcasts the specified transaction to the network.
   * @abstract
   * @param {string} txHex raw transaction as a HEX literal
   */
	 sendTransaction (txHex) {
    return Promise.resolve('')
  }

	async send(params) {

		params.try = params.try || 1;
		let tryString = ` (try number ${params.try})`;
		let gas = Math.round(this.gasLimit * this.reliabilityCoef * params.try);

		try {

			const txParams = {
				// nonce: this.currentNonce++, // set as default
				// gasPrice: this.gasPrice, // set as default
				gas
			};
			if (this.contract) {
				txParams.value = '0x0';
				txParams.to = this.erc20model.sc;
				txParams.data = this.contract.methods.transfer(params.address, this.toSat(params.value)).encodeABI();
			} else {
				txParams.value = this.toSat(params.value);
				txParams.to = params.address;
			}

			return new Promise(resolve => {
				eth.sendTransaction(txParams)
					.on('transactionHash', (hash) => {
						log.log(`Formed Tx to send ${params.value} ${this.token} to ${params.address} with gas limit of ${gas}${tryString}, Tx hash: ${hash}.`);
						resolve({
							success: true,
							hash
						});
					})
					.on('receipt', (receipt) => {
						log.log(`Got Tx ${receipt.transactionHash} receipt, ${params.value} ${this.token} to ${params.address}: ${this.formTxMessage(receipt)}.`);
					})
					.on('confirmation', (confirmationNumber, receipt) => {
						if (confirmationNumber === 0) {
							log.log(`Got the first confirmation for ${receipt.transactionHash} Tx, ${params.value} ${this.token} to ${params.address}. Tx receipt: ${this.formTxMessage(receipt)}.`);
						}
					})
					.on('error', (e, receipt) => {  // If out of gas error, the second parameter is the receipt
						if (!e.toString().includes('Failed to check for transaction receipt')) { // Known bug that after Tx sent successfully, this error occurred anyway https://github.com/ethereum/web3.js/issues/3145
							log.error(`Failed to send ${params.value} ${this.token} to ${params.address} with gas limit of ${gas}. ` + e);
							resolve({
								success: false,
								error: e.toString()
							});
						}
					}).catch(e => {
						// Duplicates on-error
					});
			});

		} catch (e) {
			log.warn(`Error while sending ${params.value} ${this.token} to ${params.address} with gas limit of ${gas}${tryString} in send() of ${utils.getModuleName(module.id)} module. Error: ` + e);
			return {
				success: false,
				error: e.toString()
			}
		}
		
	}

	getErc20token(contract) {
		let token;
		Object.keys(erc20models).forEach((t) => {
			if (utils.isStringEqualCI(erc20models[t].sc, contract)) {
				token = erc20models[t]
			}
		});
		return token;
	}

	formTxMessage(tx) {
		let token = this.getErc20token(tx.contract);
		if (token) {
			token = token.token;
		} else {
			token = tx.contract ? tx.contract : 'ETH';
		}
		let status = tx.status ? ' is accepted' : tx.status === false ? ' is FAILED' : '';
		let amount = tx.amount ? ` for ${tx.amount} ${tx.isAmountPlain ? '(plain contract value)' : token}` : '';
		let height = tx.height ? ` ${status ? 'and ' : ''}included at ${tx.height} blockchain height` : '';
		let time = tx.timestamp ? ` (${utils.formatDate(tx.timestamp).YYYY_MM_DD_hh_mm} — ${tx.timestamp})` : '';
		let hash = tx.hash;
		let gasUsed = tx.gasUsed ? `, ${tx.gasUsed} gas used` : '';
		let gasPrice = tx.gasPrice ? `, gas price is ${tx.gasPrice}` : '';
		let fee;
		if (tx.gasUsed && tx.gasPrice) {
			fee = +ethUtils.fromWei(String(+tx.gasUsed * +tx.gasPrice));
		}
		fee = fee ? `, ${fee} ETH fee` : '';
		let nonce = tx.nonce ? `, nonce — ${tx.nonce}` : '';
		let senderId = utils.isStringEqualCI(tx.senderId, this.account.address) ? 'Me' : tx.senderId;
		let recipientId = utils.isStringEqualCI(tx.recipientId, this.account.address) ? 'Me' : tx.recipientId;
		let contract = tx.contract ? ` via ${token} contract` : '';
		let message = `Tx ${hash}${amount} from ${senderId} to ${recipientId}${contract}${status}${height}${time}${gasUsed}${gasPrice}${fee}${nonce}`
		return message
	}

};
