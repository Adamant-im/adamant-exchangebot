const Store = require('./Store');
const api = require('./api');
const config = require('./configReader');
const exchangeTrans = require('./exchangeTrans');
const chatTrans = require('./chatTrans');
const log = require('../helpers/log');

function check() {
	try {
		// const tx = api.get('uri', 'chats/get/?recipientId=' + Store.user.adm.address + '&orderBy=timestamp:desc&fromHeight=' + Store.lastHeight).transactions;
		const tx = api.get('uri', 'chats/get/?recipientId=' + Store.user.adm.address + '&orderBy=timestamp:desc&limit=10').transactions;

		tx.forEach(t => {
			const {type} = t;
			if (type !== 8) {
				return;
			}
			const chat = t.asset.chat;
			const msg = api.decodeMsg(chat.message, t.senderPublicKey, config.passPhrase, chat.own_message);
			try {
				const data = JSON.parse(msg);
				let coin = 'ADM';
				if (~data.type.indexOf('_transaction')) {
					coin = data.type.split('_')[0];
				}
				exchangeTrans({t, coin, msg, data});
			} catch (e) {
				chatTrans(t, msg);
			}
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