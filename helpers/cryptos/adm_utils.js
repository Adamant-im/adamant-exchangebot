const Store = require('../../modules/Store');
const api = require('../../modules/api');
const log = require('../../helpers/log');
const {SAT} = require('../const');
const config = require('../../modules/configReader');
const utils = require('../utils');
const User = Store.user.ADM;

module.exports = {

	get FEE() {
		return Store.comissions.ADM;
	},
	syncGetTransaction(hash, tx){
		return {
			blockNumber: tx.blockId,
			hash: tx.id,
			sender: tx.senderId,
			recipient: tx.recipientId,
			amount: +(tx.amount / SAT).toFixed(8)
		};
	},
	async getLastBlock() {
		const blocks = await api.get('blocks', { limit: 1 });
		if (blocks.success) {
			return blocks.data.blocks[0].height
		} else {
			log.warn(`Failed to get last block in getLastBlock() of ${utils.getModuleName(module.id)} module. ${blocks.errorMessage}.`);
		}
	},
	async getTransactionStatus(txid) {
		const tx = await api.get('transactions/get', { id: txid });
		if (tx.success) {
			return {
				blockNumber: tx.data.transaction.height,
				status: true
			};
		} else {
			log.warn(`Failed to get Tx ${txid} in getTransactionStatus() of ${utils.getModuleName(module.id)} module. ${tx.errorMessage}.`);
		}
	},
	async updateBalance() {
		const account = await api.get('accounts', { address: config.address });
		if (account.success) {
			User.balance = account.data.account.balance / SAT
		} else {
			log.warn(`Failed to get account info in updateBalance() of ${utils.getModuleName(module.id)} module. ${account.errorMessage}.`);
		}
	},
	async send(params) {
		const { address, value, comment } = params;
		let payment = await api.sendMessage(config.passPhrase, address, comment, 'rich', value);
		if (payment.success) {
			return {
				success: payment.data.success,
				hash: payment.data.transactionId
			};
		} else {
			log.warn(`Failed to send ${value} ADM to ${address} with comment ${comment} in send() of ${utils.getModuleName(module.id)} module. ${account.errorMessage}.`);
			return {
				success: false
			};
		}
	}

};
