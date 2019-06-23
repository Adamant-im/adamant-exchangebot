const api = require('../../modules/api');
const config = require('../../modules/configReader');
const eth_utils = require('./eth_utils');
const adm_utils = require('./adm_utils');

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
	async getAddressCryptoFromAdmAddressADM(coin, admAddress) {
		try {
			const resp = await api.syncGet(`/api/states/get?senderId=${admAddress}&key=${coin.toLowerCase()}:address`);
			if (resp && resp.success) {
				return resp.transactions[0].asset.state.value;
			} else {
				return null;
			}
		} catch (e) {
			console.log('Error in getAddressCryptoFromAdmAddressADM(): ' + e);
			return null;
		}
	},
	ETH: eth_utils,
	ADM: adm_utils
};
