const api = require('../../modules/api');
const config = require('../../modules/configReader');
const eth_utils = require('./eth_utils');
const adm_utils = require('./adm_utils');
const log = require('../log');

module.exports = {
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
	thousandSeparator(num) {
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
			output += '.' + parts[1];
		}
		return output;
	},
	async getAddressCryptoFromAdmAddressADM(coin, admAddress) {
		try {
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
	ETH: eth_utils,
	ADM: adm_utils
};