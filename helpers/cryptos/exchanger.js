const api = require('../../modules/api');
const config = require('../../modules/configReader');
const log = require('../log');
const db = require('../../modules/DB');
const Store = require('../../modules/Store');
const utils = require('../utils');
const adm_utils = require('./adm_utils');
const eth_utils = require('./eth_utils');
const erc20_utils = require('./erc20_utils');

module.exports = {

	async getKvsCryptoAddress(coin, admAddress) {

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
			log.warn(`Failed to get ${coin} address for ${admAddress} from KVS in getKvsCryptoAddress() of ${utils.getModuleName(module.id)} module. ${kvsRecords.errorMessage}.`);
		}

	},

	async userDailyValue(senderId) {
		return (await db.paymentsDb.find({
			transactionIsValid: true,
			senderId: senderId,
			needToSendBack: false,
			inAmountMessageUsd: { $ne: null },
			date: { $gt: (utils.unix() - 24 * 3600 * 1000) } // last 24h
		})).reduce((r, c) => {
			return +r + +c.inAmountMessageUsd;
		}, 0);
	},

	createErc20tokens() {
		config.erc20.forEach(async t => {
			this[t] = new erc20_utils(t, this.ETH);
		});
	},

	async refreshExchangedBalances() {
		for (const crypto of config.exchange_crypto) {
			await this[crypto].getBalance()
		}
	},

	isERC20(coin) {
		return config.erc20.includes(coin.toUpperCase());
	},

	isEthOrERC20(coin) {
		return coin.toUpperCase() === 'ETH' || config.erc20.includes(coin.toUpperCase());
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

	isAcceptedAndExchangedEqual() {
		return utils.isArraysEqual(config.accepted_crypto, config.exchange_crypto);
	},

	get acceptedCryptoList() {
		return config.accepted_crypto.join(', ');
	},

	get exchangedCryptoList() {
		return config.exchange_crypto.join(', ');
	},

	get iAcceptAndExchangeString() {
		if (this.isAcceptedAndExchangedEqual()) {
			return `I exchange anything between *${this.acceptedCryptoList}*`
		} else {
			return `I accept *${this.acceptedCryptoList}* for exchange to *${this.exchangedCryptoList}*`
		}
	},

	isFiat(coin) {
		return ['USD', 'RUB', 'EUR', 'CNY', 'JPY'].includes(coin);
	},

	hasTicker(coin) { // if coin has ticker like COIN/OTHERCOIN or OTHERCOIN/COIN
		const pairs = Object.keys(Store.currencies).toString();
		return pairs.includes(',' + coin + '/') || pairs.includes('/' + coin);
	},

	ETH: new eth_utils('ETH'),
	ADM: new adm_utils(),

};
