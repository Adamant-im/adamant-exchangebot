const Store = require('./Store');
const api = require('./api');
const txParser = require('./incomingTxsParser');
const log = require('../helpers/log');
const config = require('./configReader');

async function check() {
	try {
		let tx;
		// if (config.isDev) {
		// 	tx = (await api.get('uri', 'chats/get/?recipientId=' + Store.user.ADM.address + '&orderBy=timestamp:desc&limit=10')).transactions;
		// } else {
			tx = (await api.get('uri', 'chats/get/?recipientId=' + Store.user.ADM.address + '&orderBy=timestamp:desc&fromHeight=' + Store.lastHeight)).transactions;
		// }
		tx.forEach(t => {
			if (t.type !== 8) {
				return;
			}
			txParser(t);
		});
		Store.updateLastBlock();
	} catch (e) {
		log.error('Error while checking new transactions: ' + e);
	}
}
module.exports = () => {
	setInterval(check, 4500);
};
