const api = require('../../modules/api');
const config = require('../../modules/configReader');
const log = require('../log');
const db = require('../../modules/DB');
const constants = require('../const');
const utils = require('../utils');
const axios = require('axios');
const adm_utils = require('./adm_utils');
const eth_utils = require('./eth_utils');
const erc20_utils = require('./erc20_utils');
const dash_utils = require('./dash_utils');

module.exports = {

	currencies: undefined,

	async updateCryptoRates() {

		let url = config.infoservice + '/get';
		let rates = await axios.get(url, {})
			.then(function (response) {
				return response.data ? response.data.result : undefined
			})
			.catch(function (error) {
				log.warn(`Unable to fetch crypto rates in updateCryptoRates() of ${utils.getModuleName(module.id)} module. Request to ${url} failed with ${error.response ? error.response.status : undefined} status code, ${error.toString()}${error.response && error.response.data ? '. Message: ' + error.response.data.toString().trim() : ''}.`);
			});

		if (rates) {
			this.currencies = rates;
		} else {
			log.warn(`Unable to fetch crypto rates in updateCryptoRates() of ${utils.getModuleName(module.id)} module. Request was successfull, but got unexpected results: ` + rates);
		}

	},

	/**
	 * Returns rate for from/to
	 * @param {String} from Like 'ADM'
	 * @param {String} to Like 'ETH'
	 * @returns {Number} or NaN or undefined
	 */
	getRate(from, to) {
		try {
			let price = this.currencies[from + '/' + to] || 1 / this.currencies[to + '/' + from];
			if (!price) {
				// We don't have direct or reverse rate, calculate it from /USD rates
				const priceFrom = this.currencies[from + '/USD'];
				const priceTo = this.currencies[to + '/USD'];
				price = priceFrom / priceTo;
			}
			return price;
		} catch (e) {
			log.error(`Unable to calculate price of ${from} in ${to} in getPrice() of ${utils.getModuleName(module.id)} module: ` + e);
		}
	},

	/**
	 * Returns value of amount 'from' currency in 'to' currency
	 * @param {String} from Like 'ADM'
	 * @param {String} to Like 'ETH'
	 * @param {Number} amount Amount of 'from' currency
	 * @param {Boolean} considerExchangerFee If false, do direct market calculation. If true, deduct the exchanger's and blockchain fees
	 * @returns {Number, Number} or { NaN, NaN }
	 */
	convertCryptos(from, to, amount = 1, considerExchangerFee = false) {
		try {
			from = from.toUpperCase();
			to = to.toUpperCase();
			let rate = this.getRate(from, to);
			let networkFee = 0;
			if (considerExchangerFee) {
				rate *= 1 - config['exchange_fee_' + from] / 100;
				networkFee = this[to].FEE;
				if (this.isERC20(to)) {
					networkFee = this.convertCryptos('ETH', to, networkFee).outAmount;
				}
			};
			let value = rate * +amount - networkFee;
			return {
				outAmount: +value.toFixed(constants.PRECISION_DECIMALS),
				exchangePrice: +rate.toFixed(constants.PRECISION_DECIMALS)
			};
		} catch (e) {
			log.error(`Unable to calculate ${amount} ${from} in ${to} in convertCryptos() of ${utils.getModuleName(module.id)} module: ` + e);
			return {
				outAmount: NaN,
				exchangePrice: NaN
			};
		}
	},

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

	async getExchangedCryptoList(excludeCoin) {
		excludeCoin = excludeCoin ? excludeCoin.toUpperCase() : '';
		await this.refreshExchangedBalances();
		return utils.replaceLastOccurrence(config.exchange_crypto.filter(crypto => this[crypto].token !== excludeCoin && this[crypto].balance > 0).join(', '), ', ', ' or ');
	},

	isFiat(coin) {
		return ['USD', 'RUB', 'EUR', 'CNY', 'JPY'].includes(coin);
	},

	isInstantSendValid(coin) {
		return ['DASH'].includes(coin);
	},

	hasTicker(coin) { // if coin has ticker like COIN/OTHERCOIN or OTHERCOIN/COIN
		const pairs = Object.keys(this.currencies).toString();
		return pairs.includes(',' + coin + '/') || pairs.includes('/' + coin);
	},

	ETH: new eth_utils('ETH'),
	ADM: new adm_utils(),
	DASH: new dash_utils('DASH')

};

module.exports.updateCryptoRates();

setInterval(() => {
	module.exports.updateCryptoRates();
}, constants.UPDATE_CRYPTO_RATES_INVERVAL);
