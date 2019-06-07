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
	updateLastBlock() {
		try {
			const lastBlock = api.get('uri', 'blocks').blocks[0];
			this.updateSystem('lastBlock', lastBlock);
		} catch (e) {
			log.error(' Store update last block ' + e);
		}
	},
	updateCurrencies(){
		request('https://info.adamant.im/get', (err, body)=>{
			try {
				const data = JSON.parse(body.body);
				if (data.success){
					this.currencies = data.result;
				}
			} catch (e){
				log.error(' update currencys ' + e);
			};
		});
	}
};

module.exports.updateCurrencies();

setTimeout(() => {
	module.exports.updateCurrencies();
}, 60 * 1000);