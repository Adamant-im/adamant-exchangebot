const Store = require('../../modules/Store');
const api = require('../../modules/api');
const log = require('../../helpers/log');
const {SAT} = require('../const');
const config = require('../../modules/configReader');
const utils = require('../utils');
const User = Store.user.ADM;

const baseCoin = require('./baseCoin');
module.exports = new class admCoin extends baseCoin {

	constructor () {
    super()
		this.cache.lastBlock = { lifetime: 5000 };
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
			amount: +(tx.amount / SAT).toFixed(8)
		};
	}

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

	async getLastBlockHeight() {
		const block = await this.getLastBlock();
		return block ? block.height : undefined;
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

	async updateBalance() {
		const account = await api.get('accounts', { address: config.address });
		if (account.success) {
			User.balance = account.data.account.balance / SAT
		} else {
			log.warn(`Failed to get account info in updateBalance() of ${utils.getModuleName(module.id)} module. ${account.errorMessage}.`);
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
