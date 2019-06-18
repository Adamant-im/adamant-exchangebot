const Store = require('../../modules/Store');
const api = require('../../modules/api');
const log = require('../../helpers/log');

const {
	SAT
} = require('../const');
const config = require('../../modules/configReader');
const User = Store.user.ADM;

module.exports = {
	get FEE() {
		return Store.comissions.ADM;
	},
	async send(params) {
		try {
			const {
				address,
				value
			} = params;
			const res = api.send(User.passPhrase, address, value);
			if (!res) {
				return {
					success: false
				};
			}
			return {
				success: res.success,
				hash: res.transactionId
			};
		} catch (e) {
			log.error(' utils ADM send ' + e);
		}
	},
	async updateBalance() {
		try {
			User.balance = (await api.get('uri', 'accounts?address=' + User.address)).account.balance / SAT;
		} catch (e) {
			log.error(' get balance ADM ' + e);
		}
	}
};
module.exports.updateBalance();
setInterval(() => {
	module.exports.updateBalance();
}, 1000 * 60);
