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
		this.account.network = this.account.keys.network;
		this.account.keyPair = this.account.keys.keyPair;
		this.account.address = this.account.keys.address;
		this.account.privateKey = this.account.keys.privateKey;
		setTimeout(() => this.getBalance().then((balance) => log.log(`Initial ${this.token} balance: ${utils.isPositiveOrZeroNumber(balance) ? balance.toFixed(constants.PRINT_DECIMALS) : 'unable to receive'}`)), 1000);
	}

	/**
	 * Returns coin decimals (precision)
	 * @abstract
	 * @returns {Number}
	 */
	get decimals() {
		return undefined
	}

	/**
	 * Returns multiplier for sats
	 * @returns {Number}
	 */
	get multiplier() {
		return Math.pow(10, this.decimals)
	}

	/**
	 * Returns wallet address
	 * @returns {String}
	 */
	get address() {
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
			return Math.floor(+tokenValue * this.multiplier)
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
	 * Used only for this.getLastBlockHeight()
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
	 * Returns balance in coins (not satoshis) from cache, if it's up to date. If not, makes an API request and updates cached data.
	 * @abstract
	 * @returns {Number} or outdated cached value, if unable to fetch data; it may be undefined also
	 */
	async getBalance() {
		return undefined;
	}

	/**
	 * Returns balance in coins (not satoshis) from cache. It may be outdated.
	 * @abstract
	 * @returns {Number} cached value; it may be undefined
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
	 * @returns {Object}
	 * Internal use. Not needed for some coins.
	 */
	getBlock(blockId) {
		return {}
	}

	/**
	 * Returns Tx status and details from the blockchain
	 * @abstract
	 * @param {String} txid Tx ID to fetch
	 * @returns {Object}
	 * Used for income Tx security validation (deepExchangeValidator): senderId, recipientId, amount, timestamp
	 * Used for checking income Tx status (confirmationsCounter), exchange and send-back Tx status (sentTxChecker): status, confirmations || height
	 * Not used, additional info: hash (already known), blockId, fee, recipients, senders
	 */
	async getTransaction(txid) {
		return {}
	}

	/**
	 * Retrieves unspents (UTXO)
	 * @abstract
	 * @returns {Promise<Array<{txid: string, vout: number, amount: number}>>}
	 */
	getUnspents() {
		return Promise.resolve([])
	}

	/**
	 * Creates a transfer transaction hex (raw Tx) and ID
	 * @param {string} address receiver address
	 * @param {number} amount amount to transfer (coins, not satoshis)
	 * @param {number} fee transaction fee (coins, not satoshis)
	 * @returns {Promise<{hex: string, txid: string}>}
	 */
	createTransaction(address = '', amount = 0, fee) {
		return this.getUnspents().then(unspents => {
			const hex = this._buildTransaction(address, amount, unspents, fee)
			let txid = bitcoin.crypto.sha256(Buffer.from(hex, 'hex'))
			txid = bitcoin.crypto.sha256(Buffer.from(txid))
			txid = txid.toString('hex').match(/.{2}/g).reverse().join('')
			return { hex, txid }
		})
	}

	/**
	 * Creates a raw transaction as a hex string
	 * @param {string} address target address
	 * @param {number} amountInSat amount to send (coins, not satoshis)
	 * @param {Array<{txid: string, amount: number, vout: number}>} unspents unspent transactions to use as inputs
	 * @param {number} fee transaction fee in primary units (BTC, DOGE, DASH, etc)
	 * @returns {string}
	 */
	_buildTransaction(address, amount, unspents, fee) {

		try {
			const amountInSat = this.toSat(amount);
			const txb = new bitcoin.TransactionBuilder(this.account.network);
			txb.setVersion(1);
			const target = amountInSat + this.toSat(fee);
			let transferAmount = 0;
			let inputs = 0;
			unspents.forEach(tx => {
				const amt = Math.floor(tx.amount);
				if (transferAmount < target) {
					txb.addInput(tx.txid, tx.vout);
					transferAmount += amt;
					inputs++;
				}
			})
			txb.addOutput(bitcoin.address.toOutputScript(address, this.account.network), amountInSat);
			txb.addOutput(this.address, transferAmount - target);
			for (let i = 0; i < inputs; ++i) {
				txb.sign(i, this.account.keyPair)
			}
			const txHex = txb.build().toHex();
			return txHex

		} catch (e) {
			log.warn(`Error while building Tx to send ${amount} ${this.token} to ${address} with ${fee} ${this.token} fee in _buildTransaction() of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

	/**
	 * Broadcasts the specified transaction to the network
	 * @abstract
	 * @param {string} txHex raw transaction as a HEX literal
	 */
	sendTransaction(txHex) {
		return Promise.resolve('')
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
				.then(result => {
					log.log(`Successfully built Tx ${result.txid} to send ${params.value} ${this.token} to ${params.address} with ${fee} ${this.token} fee: ${result.hex}.`);
					return this.sendTransaction(result.hex)
						.then(hash => {
							log.log(`Successfully broadcasted Tx to send ${params.value} ${this.token} to ${params.address} with ${fee} ${this.token} fee, Tx hash: ${hash}.`);
							return {
								success: true,
								hash
							};
						})
						.catch(e => {
							return {
								success: false,
								error: e.toString()
							}
						})
				})
				.catch(e => {
					return {
						success: false,
						error: e.toString()
					}
				})
		} catch (e) {
			log.warn(`Error while sending ${params.value} ${this.token} to ${params.address} with ${fee} ${this.token} fee in send() of ${utils.getModuleName(module.id)} module: ` + e);
			return {
				success: false,
				error: e.toString()
			}
		}
	}

	/**
	 * Formats Tx info
	 * Coin implementations must modify results specifically
	 * @param {object} tx Tx
	 * @returns {object} Formatted Tx info
	 */
	_mapTransaction(tx) {
		try {

			let addressField = tx.vin[0].address ? 'address' : 'addr';
			let senders = utils.getUnique(tx.vin.map(input => input[addressField])).filter(sender => sender !== undefined && sender !== 'undefined');
			let recipients = utils.getUnique(tx.vout.reduce((list, out) => {
				list.push(...out.scriptPubKey.addresses)
				return list
			}, [])).filter(sender => sender !== undefined && sender !== 'undefined');

			let recipientId, senderId;
			// In-chat transfers have one sender
			if (senders.length === 1) {
				senderId = senders[0];
			} else {
				senderId = `${senders.length} addresses`
			}
			// In-chat transfers have 2 recipients: a recipient and a change to sender
			recipients = recipients.filter(recipient => recipient !== senderId)
			if (recipients.length === 1) {
				recipientId = recipients[0];
			} else {
				recipientId = `${recipients.length} addresses`
			}

			// Calculate amount from outputs:
			let amount = tx.vout.reduce((sum, t) =>
				(recipientId === t.scriptPubKey.addresses[0] ? sum + Number(t.value) : sum), 0).toFixed(this.decimals);

			const confirmations = tx.confirmations
			const timestamp = tx.time ? tx.time * 1000 : undefined;
			let fee = tx.fees;
			if (!fee) {
				const totalIn = tx.vin.reduce((sum, x) => sum + (x.value ? +x.value : 0), 0);
				const totalOut = tx.vout.reduce((sum, x) => sum + (x.value ? +x.value : 0), 0);
				fee = (totalIn - totalOut).toFixed(this.decimals)
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
				height: tx.height
			}

		} catch (e) {
			log.warn(`Error while formatting Tx ${tx ? tx.txid : undefined} for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
			return tx;
		}
	}

	/**
	 * Builds log message from formed Tx
	 * @param {object} tx Tx
	 * @returns {string} Log message
	 */	
	formTxMessage(tx) {
		try {

			let token = this.token;
			let status = tx.status ? ' is accepted' : tx.status === false ? ' is FAILED' : '';
			let amount = tx.amount ? ` for ${tx.amount} ${token}` : '';
			let height = tx.height ? ` ${status ? 'and ' : ''}included at ${tx.height} blockchain height` : '';
			let confirmations = tx.confirmations ? ` and has ${tx.confirmations} confirmations` : '';
			let time = tx.timestamp ? ` (${utils.formatDate(tx.timestamp).YYYY_MM_DD_hh_mm} — ${tx.timestamp})` : '';
			let hash = tx.hash;
			let fee = tx.fee || tx.fee === 0 ? `, ${tx.fee} ${token} fee` : '';
			let senderId = utils.isStringEqualCI(tx.senderId, this.account.address) ? 'Me' : tx.senderId;
			let recipientId = utils.isStringEqualCI(tx.recipientId, this.account.address) ? 'Me' : tx.recipientId;
			let message = `Tx ${hash}${amount} from ${senderId} to ${recipientId}${status}${height}${time}${confirmations}${fee}`
			return message

		} catch (e) {
			log.warn(`Error while building Tx ${tx ? tx.id : undefined} message for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
			return tx;
		}
	}

};
