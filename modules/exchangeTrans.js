const api = require('./api');
const config = require('./configReader');

module.exports = (tx) => {
	const chat = tx.asset.chat;
	const encrypted_text = api.decodeMsg(chat.message, tx.senderPublicKey, config.passphrase, chat.own_message);
	console.log('exchangeTrans ', tx.amount, encrypted_text);
};
