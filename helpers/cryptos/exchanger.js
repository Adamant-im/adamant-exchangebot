const api = require('../../modules/api');
const config = require('../../modules/configReader');
const eth_utils = require('./eth_utils');
const adm_utils = require('./adm_utils');
const log = require('../log');
const db = require('../../modules/DB');
const Store = require('../../modules/Store');

module.exports = {

	async getAddressCryptoFromAdmAddressADM(coin, admAddress) {

		if (this.isERC20(coin)) {
			coin = 'ETH';
		}
		const kvsRecords = await api.get('states/get', { senderId: admAddress, key: coin.toLowerCase() + ":address" });
		if (kvsRecords.success) {
			if (kvsRecords.data.transactions.length) {
				return kvsRecords.data.transactions[0].asset.state.value;
			} else {
				return 'none';
			};
		} else {
			log.warn(`Failed to get ${coin} address for ${admAddress} from KVS in getAddressCryptoFromAdmAddressADM() of ${utils.getModuleName(module.id)} module. ${kvsRecords.errorMessage}.`);
		}

	},
	async userDailyValue(senderId) {
		return (await db.paymentsDb.find({
			transactionIsValid: true,
			senderId: senderId,
			needToSendBack: false,
			inAmountMessageUsd: {$ne: null},
			date: {$gt: (this.unix() - 24 * 3600 * 1000)} // last 24h
		})).reduce((r, c) => {
			return +r + +c.inAmountMessageUsd;
		}, 0);
	},
	async updateAllBalances() {
		try {
			await this.ETH.updateBalance();
			await this.ADM.updateBalance();
			for (const t of config.erc20){
				await this[t].updateBalance();
			}
		} catch (e){}
	},
	async getLastBlocksNumbers() {
		const data = {
			ETH: await this.ETH.getLastBlockHeight(),
			ADM: await this.ADM.getLastBlockHeight(),
		};
		for (const t of config.erc20) { 
			// data[t] = await this[t].getLastBlock(); // Don't do unnecessary requests
			data[t] = data['ETH'];
		}
		return data;
	},
	isKnown(coin) {
		return config.known_crypto.includes(coin);
	},
	isAccepted(coin) {
		return config.accepted_crypto.includes(coin);
	},
	isExchanged(coin) {
		return config.exchange_crypto.includes(coin);
	},
	isFiat(coin) {
		return ['USD', 'RUB', 'EUR', 'CNY', 'JPY'].includes(coin);
	},
	isHasTicker(coin) { // if coin has ticker like COIN/OTHERCOIN or OTHERCOIN/COIN
		const pairs = Object.keys(Store.currencies).toString();
		return pairs.includes(',' + coin + '/') || pairs.includes('/' + coin);
	},
	isERC20(coin) {
		return config.erc20.includes(coin.toUpperCase());
	},
	ETH: eth_utils,
	ADM: adm_utils,
};
