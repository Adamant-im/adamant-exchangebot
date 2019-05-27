const db = require('./DB');
module.exports = {
	lastBlock: null,
	get lastHeight() {
		return this.lastBlock && this.lastBlock.height || false;
	},
	updateSystem(field, data) {
		const $set = {};
		$set[field] = data;
		db.SystemDb.updateOne({}, {$set}, {
			upsert: true
		});
		this[field] = data;
	}
};
