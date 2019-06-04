const Storage = require('./Storage');
const api = require('./api');
const config = require('./configReader');
const exchangeTrans = require('./exchangeTrans');
const chatTrans = require('./chatTrans');

function check() {
	const {lastHeight} = Storage;

	const tx = api.get('uri', 'chats/get/?recipientId=' + config.address + '&orderBy=timestamp:desc&fromHeight=' + lastHeight).transactions;

	tx.forEach(t => {
		const {type} = t;
		if (type !== 8) {
			return;
		}
		if (t.amount > 1) {
			exchangeTrans(t, 'ADM');
		}
		const chat = t.asset.chat;
		const msg = api.decodeMsg(chat.message, t.senderPublicKey, config.passPhrase, chat.own_message);
		try {
			const obj = JSON.parse(msg);
			if (~obj.type.indexOf('_transaction')) {
				const coin = obj.type.split('_')[0];
				exchangeTrans(t, coin, obj);
			}
		} catch (e) {
			chatTrans(t, msg);
		}

	});
	Storage.updateLastBlock();
}

module.exports = () => {
	setInterval(check, 4500);
};


// {"type":"ETH_transaction","amount":0.1,"hash":"0x96075435aa404a9cdda0edf40c07e2098435b28547c135278f5864f8398c5d7d","comments":"Testing purposes "}