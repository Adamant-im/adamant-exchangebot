const db = require('./DB');
const log = require('../helpers/log');
const config = require('./configReader');
const axios = require('axios');
const utils = require('../helpers/utils');
const constants = require('../helpers/const');

module.exports = {

	currencies: undefined,
	lastProcessedBlockHeight: undefined,

	async getLastProcessedBlockHeight() {

		const exchangerUtils = require('../helpers/cryptos/exchanger');
		if (this.lastProcessedBlockHeight) {
			return this.lastProcessedBlockHeight
		}
		// try to get lastProcessedBlockHeight from DB
		const systemDbData = await db.systemDb.findOne();
		if (systemDbData && systemDbData.lastProcessedBlockHeight) {
			this.lastProcessedBlockHeight = systemDbData.lastProcessedBlockHeight;
			return this.lastProcessedBlockHeight
		}
		// it seems we run for a first time
		const lastBlock = await exchangerUtils.ADM.getLastBlockHeight();
		if (lastBlock) {
			await this.updateSystemDbField('lastProcessedBlockHeight', lastBlock);
			return this.lastProcessedBlockHeight
		}
		log.warn(`Unable to store last ADM block in getLastProcessedBlockHeight() of ${utils.getModuleName(module.id)} module. Will try next time.`);

	},

	async updateSystemDbField(field, data) {
		const $set = {};
		$set[field] = data;
		await db.systemDb.db.updateOne({}, { $set }, { upsert: true });
		this[field] = data;
	},

	async updateLastProcessedBlockHeight(height) {
		if (height) {
			if (!this.lastProcessedBlockHeight || height > this.lastProcessedBlockHeight) {
				await this.updateSystemDbField('lastProcessedBlockHeight', height);
			}
		}
	},

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

	getPrice(from, to) {
		try {

			from = from.toUpperCase();
			to = to.toUpperCase();
			let price = + (this.currencies[from + '/' + to] || 1 / this.currencies[to + '/' + from] || 0).toFixed(constants.PRECISION_DECIMALS);
			if (price) {
				return price;
			}
			const priceFrom = +(this.currencies[from + '/USD']);
			const priceTo = +(this.currencies[to + '/USD']);
			return +(priceFrom / priceTo || 1).toFixed(constants.PRECISION_DECIMALS);

		} catch (e) {
			log.error(`Unable to calculate ${from} in ${to}: ` + e);
			return 0;
		}
	},

	convertCryptos(from, to, amount = 1, considerExchangerFee = false) {
		try {

			let price = this.getPrice(from, to);
			if (considerExchangerFee) {
				price *= (100 - config['exchange_fee_' + from]) / 100;
			};
			price = +price.toFixed(constants.PRECISION_DECIMALS);
			return {
				outAmount: +(price * amount).toFixed(constants.PRECISION_DECIMALS),
				exchangePrice: price
			};

		} catch (e) {
			log.error(`Unable to calculate ${amount} ${from} in ${to}.`);
			return {
				outAmount: 0,
				exchangePrice: 0
			};
		}
	}

};

module.exports.updateCryptoRates();

setInterval(() => {
	module.exports.updateCryptoRates();
}, constants.UPDATE_CRYPTO_RATES_INVERVAL);
