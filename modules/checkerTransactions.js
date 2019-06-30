const Store = require('./Store');
const api = require('./api');
const txParser = require('./incomingTxsParser');
const log = require('../helpers/log');

async function check() {
	try {
		if (!Store.lastHeight){
			return;
		}
		const tx = (await api.get('transactions', 'recipientId=' + Store.user.ADM.address + '&orderBy=timestamp:desc')).transactions;
		tx.forEach(t => {
			if (t.height >= Store.lastHeight && (t.type === 8 || t.type === 0)) {
				txParser(t);
			}
			
		});
		Store.updateLastBlock();
	} catch (e) {
		log.error('Error while checking new transactions: ' + e);
	}
}
module.exports = () => {
	setInterval(check, 4500);
};
