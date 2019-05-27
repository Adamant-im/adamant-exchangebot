const db = require('./DB');
const log = require('../helpers/log');
const api = require('./api');

module.exports = {
	lastBlock: null,
	get lastHeight() {
		return this.lastBlock && this.lastBlock.height || false;
	},
	updateSystem(field, data) {
		const $set = {};
		$set[field] = data;
		db.system.updateOne({}, {
			$set
		}, {
			upsert: true
		});
		this[field] = data;
	},
	updateLastBlock() {
		try {
			const lastBlock = api.get('uri', 'blocks').blocks[0];
			this.updateSystem('lastBlock', lastBlock);
		} catch (e) {
			log.error(' Storage update last block ' + e);
		}
	}
};
