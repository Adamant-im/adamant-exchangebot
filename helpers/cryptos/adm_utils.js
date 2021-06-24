const Store = require('../../modules/Store');
const api = require('../../modules/api');
const log = require('../../helpers/log');
const constants = require('../const');
const config = require('../../modules/configReader');
const utils = require('../utils');

const baseCoin = require('./baseCoin');
module.exports = new class admCoin extends baseCoin {

	constructor () {
    super()
		this.token = 'ADM';
		this.cache.lastBlock = { lifetime: 5000 };
		this.cache.balance = { lifetime: 10000 };
		this.account.passPhrase = config.passPhrase;
		this.account.keysPair = config.keysPair;
		this.account.address = config.address;
		this.getBalance().then((balance) => log.log(`Initial ${this.token} balance: ${balance.toFixed(constants.PRINT_DECIMALS)}`));
  }

	get FEE() {
		return 0.5;
	}

	syncGetTransaction(hash, tx){
		return {
			blockId: tx.blockId,
			hash: tx.id,
			senderId: tx.senderId,
			recipientId: tx.recipientId,
			amount: +(tx.amount / constants.SAT).toFixed(8)
		};
	}

  /**
   * Returns last block from cache, if it's up to date. If not, makes an API request and updates cached data.
   * @returns {Object} or undefined, if unable to fetch data
   */
	async getLastBlock() {
		let cached = this.cache.getData('lastBlock');
		if (cached) {
			return cached;
		}
		const blocks = await api.get('blocks', { limit: 1 });
		if (blocks.success) {
			this.cache.cacheData('lastBlock', blocks.data.blocks[0]);
			return blocks.data.blocks[0]
		} else {
			log.warn(`Failed to get last block in getLastBlock() of ${utils.getModuleName(module.id)} module. ${blocks.errorMessage}.`);
		}
	}

  /**
   * Returns last block height from cache, if it's up to date. If not, makes an API request and updates cached data.
   * @returns {Number} or undefined, if unable to fetch data
   */
	async getLastBlockHeight() {
		const block = await this.getLastBlock();
		return block ? block.height : undefined;
	}

  /**
   * Returns balance in ADM from cache, if it's up to date. If not, makes an API request and updates cached data.
   * @returns {Number} or outdated cached value, if unable to fetch data; it may be undefined also
   */
	async getBalance() {
		let cached = this.cache.getData('balance');
		if (cached) {
			return utils.satsToADM(cached);
		}
		const account = await api.get('accounts', { address: config.address });
		if (account.success) {
			this.cache.cacheData('balance', account.data.account.balance);
			return utils.satsToADM(account.data.account.balance)
		} else {
			log.warn(`Failed to get account info in getBalance() of ${utils.getModuleName(module.id)} module; returning outdated cached balance. ${account.errorMessage}.`);
			return utils.satsToADM(cached); 
		}
	}

  /**
   * Returns balance in ADM from cache. It may be outdated.
   * @returns {Number} cached value; it may be undefined
   */
	get balance() {
		return utils.satsToADM(this.cache.getData('balance'))
	}

  /**
   * Updates balance in ADM manually from cache. Useful when we don't want to wait for network update.
	 * @param {Number} value New balance in ADM
   */
	set balance(value) {
		if (utils.isPositiveOrZeroNumber(value)) {
			this.cache.cacheData('balance', utils.AdmToSats(value));		
		}
	}

	async getTransactionStatus(txid) {
		const tx = await api.get('transactions/get', { id: txid });
		if (tx.success) {
			return {
				blockId: tx.data.transaction.height,
				status: true
			};
		} else {
			log.warn(`Failed to get Tx ${txid} in getTransactionStatus() of ${utils.getModuleName(module.id)} module. ${tx.errorMessage}.`);
		}
	}

	async send(params) {
		const { address, value, comment } = params;
		let payment = await api.sendMessage(config.passPhrase, address, comment, 'basic', value);
		if (payment.success) {
			return {
				success: payment.data.success,
				hash: payment.data.transactionId
			};
		} else {
			log.warn(`Failed to send ${value} ADM to ${address} with comment '${comment}' in send() of ${utils.getModuleName(module.id)} module. ${payment.errorMessage}.`);
			return {
				success: false
			};
		}
	}

};
