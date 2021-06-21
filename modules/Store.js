const db = require('./DB');
const log = require('../helpers/log');
const keys = require('adamant-api/helpers/keys');
const api = require('./api');
const {version} = require('../package.json');
const config = require('./configReader');
const axios = require('axios');

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
	comissions: {
		ADM: 0.5 // This is a stub. Ether fee returned with FEE() method in separate module
	},
	lastBlock: null,
	get lastHeight() {
		return this.lastBlock && this.lastBlock.height || false;
	},
	updateSystem(field, data) {
		const $set = {};
		$set[field] = data;
		db.systemDb.db.updateOne({}, {$set}, {upsert: true});
		this[field] = data;
	},
	async updateLastBlock() {
		// TEMP
		const blocks = await api.get('blocks', { limit: 1 });
		if (blocks.success) {
			this.updateSystem('lastBlock', blocks.data.blocks[0]);
		} else {
			log.warn(`Failed to get last block in updateLastBlock() of ${utils.getModuleName(module.id)} module. ${blocks.errorMessage}.`);
		}
	},
	async updateCurrencies() {
		let url = config.infoservice + '/get';
		let data = await axios.get(url, { })
      .then(function (response) {
				return response.data && response.data.result ? response.data.result : undefined
      })
      .catch(function (error) {
				logger.warn(`Error in updateCurrencies() of ${utils.getModuleName(module.id)} module: Request to ${url} failed with ${error.response ? error.response.status : undefined} status code, ${error.toString()}${error.response && error.response.data ? '. Message: ' + error.response.data.toString().trim() : ''}.`);
			});
		
		if (data) {
			this.currencies = data;
		} else {
			logger.warn(`Error in updateCurrencies() of ${utils.getModuleName(module.id)} module: Request to ${url} returned empty result.`);
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

