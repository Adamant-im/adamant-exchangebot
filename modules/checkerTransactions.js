const Store = require('./Store');
const api = require('./api');
const txParser = require('./incomingTxsParser');
const log = require('../helpers/log');

async function check() {
	try {
		// const tx = api.get('uri', 'chats/get/?recipientId=' + Store.user.adm.address + '&orderBy=timestamp:desc&fromHeight=' + Store.lastHeight).transactions;
		const tx = (await api.get('uri', 'chats/get/?recipientId=' + Store.user.adm.address + '&orderBy=timestamp:desc&limit=10')).transactions;
		tx.forEach(t => {
			if (t.type !== 8) {
				return;
			}
			txParser (t);
		});
		Store.updateLastBlock();
	} catch (e){
		log.error(' check transactions ' + e);
	}
}
module.exports = () => {
	setInterval(check, 4500);
};


// {"type":"ETH_transaction","amount":0.1,"hash":"0x96075435aa404a9cdda0edf40c07e2098435b28547c135278f5864f8398c5d7d","comments":"Testing purposes "}
