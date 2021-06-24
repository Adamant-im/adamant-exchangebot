const db = require('./DB');
const log = require('../helpers/log');
const keys = require('adamant-api/helpers/keys');
const api = require('./api');
const {version} = require('../package.json');
const config = require('./configReader');
const axios = require('axios');
const utils = require('../helpers/utils');

// ADM data
const AdmKeysPair = keys.createKeypairFromPassPhrase(config.passPhrase);
const AdmAddress = keys.createAddressFromPublicKey(AdmKeysPair.publicKey);
// ETH data
const ethData = api.eth.keys(config.passPhrase);

module.exports = {
	version,
	botName: AdmAddress,
	user: {
		ADM: {
			passPhrase: config.passPhrase,
			keysPair: AdmKeysPair,
			address: AdmAddress
		},
		ETH: {
			address: ethData.address,
			privateKey: ethData.privateKey,
		}
	},

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
		await db.systemDb.db.updateOne({}, {$set}, {upsert: true});
		this[field] = data;
	},
	async updateLastProcessedBlockHeight(height) {
		if (height) {
			if (!this.lastProcessedBlockHeight || height > this.lastProcessedBlockHeight) {
				await this.updateSystemDbField('lastProcessedBlockHeight', height);
			}
		}
	},
	async updateCurrencies() {
		let url = config.infoservice + '/get';
		let data = await axios.get(url, { })
      .then(function (response) {
				return response.data && response.data.result ? response.data.result : undefined
      })
      .catch(function (error) {
				log.warn(`Error in updateCurrencies() of ${utils.getModuleName(module.id)} module: Request to ${url} failed with ${error.response ? error.response.status : undefined} status code, ${error.toString()}${error.response && error.response.data ? '. Message: ' + error.response.data.toString().trim() : ''}.`);
			});
		
		if (data) {
			this.currencies = data;
		} else {
			log.warn(`Error in updateCurrencies() of ${utils.getModuleName(module.id)} module: Request to ${url} returned empty result.`);
		}

	},
	getPrice(from, to){
		try {
			from = from.toUpperCase();
			to = to.toUpperCase();
			let price = + (this.currencies[from + '/' + to] || 1 / this.currencies[to + '/' + from] || 0).toFixed(8);
			if (price){
				return price;
			}
			const priceFrom = +(this.currencies[from + '/USD']);
			const priceTo = +(this.currencies[to + '/USD']);
			return +(priceFrom / priceTo || 1).toFixed(8);
		} catch (e){
			log.error('Error while calculating getPrice(): ', e);
			return 0;
		}
	},
	mathEqual(from, to, amount, doNotAccountFees){
		let price = this.getPrice(from, to);
		if (!doNotAccountFees){
			price *= (100 - config['exchange_fee_' + from]) / 100;
		};
		if (!price){
			return {
				outAmount: 0,
				exchangePrice: 0
			};
		}
		price = +price.toFixed(8);
		return {
			outAmount: +(price * amount).toFixed(8),
			exchangePrice: price
		};
	}
};

config.notifyName = `${config.bot_name} (${module.exports.botName})`;
module.exports.updateCurrencies();

setInterval(() => {
	module.exports.updateCurrencies();
}, 60 * 1000);

