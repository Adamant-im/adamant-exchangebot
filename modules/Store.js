const db = require('./DB');
const log = require('../helpers/log');
const keys = require('adamant-api/helpers/keys');
const api = require('./api');
const config = require('./configReader');
const request = require('request');
const AdmKeysPair = keys.createKeypairFromPassPhrase(config.passPhrase);
const AdmAddress = keys.createAddressFromPublicKey(AdmKeysPair.publicKey);
const ethData = api.eth.keys(config.passPhrase);

module.exports = {
	user: {
		adm: {
			passPhrase: config.passPhrase,
			keysPair: AdmKeysPair,
			address: AdmAddress
		},
		eth: {
			address: ethData.address,
			privateKey: ethData.privateKey,
		}
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
		try {
			const lastBlock = (await api.get('uri', 'blocks')).blocks[0];
			this.updateSystem('lastBlock', lastBlock);
		} catch (e) {
			log.error(' Store update last block ' + e);
		}
	},
	async updateCurrencies(){
		try {
			const data = await api.syncGet(config.infoservice + '/get', true);
			if (data.success){
				this.currencies = data.result;
			}
		} catch (e){
			log.error('Update currencys ' + e);
		};
	}
};

module.exports.updateCurrencies();

setTimeout(() => {
	module.exports.updateCurrencies();
}, 60 * 1000);
