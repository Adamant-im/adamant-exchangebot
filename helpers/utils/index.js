const api = require('../../modules/api');
const config = require('../../modules/configReader');
const eth_utils = require('./eth_utils');
const adm_utils = require('./adm_utils');
const log = require('../log');
const db = require('../../modules/DB');
const Store = require('../../modules/Store');

module.exports = {
	formatDate(timestamp) {
    if (!timestamp) return false;
    let formattedDate = { };
    let dateObject = new Date(timestamp);
    formattedDate.year = dateObject.getFullYear();
    formattedDate.month = ("0" + (dateObject.getMonth() + 1)).slice(-2);
    formattedDate.date = ("0" + dateObject.getDate()).slice(-2);
    formattedDate.hours = ("0" + dateObject.getHours()).slice(-2);
    formattedDate.minutes = ("0" + dateObject.getMinutes()).slice(-2);
    formattedDate.seconds = ("0" + dateObject.getSeconds()).slice(-2);
    formattedDate.YYYY_MM_DD = formattedDate.year + "-" + formattedDate.month + "-" + formattedDate.date;
    formattedDate.YYYY_MM_DD_hh_mm = formattedDate.year + "-" + formattedDate.month + "-" + formattedDate.date + " " + formattedDate.hours + ":" + formattedDate.minutes;
    formattedDate.hh_mm_ss = formattedDate.hours + ":" + formattedDate.minutes + ":" + formattedDate.seconds;
    return formattedDate
  },
	unix() {
		return new Date().getTime();
	},
	sendAdmMsg(address, msg, type = 'message') {
		if (msg && !config.isDev || true) {
			try {
				return api.send(config.passPhrase, address, msg, type).success || false;
			} catch (e) {
				return false;
			}
		}
	},
	thousandSeparator(num, doBold) {
		var parts = (num + '').split('.'),
			main = parts[0],
			len = main.length,
			output = '',
			i = len - 1;

		while (i >= 0) {
			output = main.charAt(i) + output;
			if ((len - i) % 3 === 0 && i > 0) {
				output = ' ' + output;
			}
			--i;
		}

		if (parts.length > 1) {
			if (doBold) {
				output = `**${output}**.${parts[1]}`;
			} else {
				output = `${output}.${parts[1]}`;
			}
		}
		return output;
	},
	async getAddressCryptoFromAdmAddressADM(coin, admAddress) {
		try {
			if (this.isERC20(coin)) {
				coin = 'ETH';
			}
			const resp = await api.syncGet(`/api/states/get?senderId=${admAddress}&key=${coin.toLowerCase()}:address`);
			if (resp && resp.success) {
				if (resp.transactions.length) {
					return resp.transactions[0].asset.state.value;
				} else {
					return 'none';
				};
			};
		} catch (e) {
			log.error(' in getAddressCryptoFromAdmAddressADM(): ' + e);
			return null;
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
			ETH: await this.ETH.getLastBlockNumber(),
			ADM: await this.ADM.getLastBlockNumber(),
		};
		for (const t of config.erc20) { 
			// data[t] = await this[t].getLastBlockNumber(); // Don't do unnecessary requests
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
	isArraysEqual(array1, array2) {
		return array1.length === array2.length && array1.sort().every(function(value, index) { return value === array2.sort()[index]});
	},
	ETH: eth_utils,
	ADM: adm_utils,
};
