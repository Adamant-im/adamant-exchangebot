const Store = require('./Store');
const api = require('./api');
const txParser = require('./incomingTxsParser');
const log = require('../helpers/log');

async function check() {
	try {
		console.log(Store.lastHeight)
		const tx = (await api.get('uri', 'chats/get/?recipientId=' + Store.user.ADM.address + '&orderBy=timestamp:desc&fromHeight=' + (Store.lastHeight - 5))).transactions;

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
	setInterval(check, 1000);
};
