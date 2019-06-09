const db = require('./DB');
const config = require('./configReader');
const $u = require('../helpers/utils');
const api = require('./api');
const Store = require('./Store');

module.exports = async () => {
	const {
		paymentsDb
	} = db;

	(await paymentsDb.find({
		transactionIsValid: true,
		isFinished: false,
		transactionFailed: false
	})).forEach(async pay => {
		try {
			const {
				inConformations,
				inCurrency
			} = pay;
			if (inCurrency === 'ETH' && pay.in_tx_status !== true) {
				const in_tx_status = await $u[inCurrency].getTransactionStatus(pay.inTxid).status;
				console.log({
					in_tx_status
				});
			}
			if (inConformations < config.min_conformations) {

			}
		} catch (e) {

		}
	});


};
// setTimeout(() => {
// 	module.exports();
// }, 2000);

setInterval(async () => {
	const tx = (await api.get('uri', 'chats/get/?recipientId=' + Store.user.ADM.address + '&orderBy=timestamp:desc&limit=1')).transactions[0];
	const chat = tx.asset.chat;
	const msg = JSON.parse(api.decodeMsg(chat.message, tx.senderPublicKey, config.passPhrase, chat.own_message));
	console.log(msg.amount, await $u.ETH.getTransactionStatus(msg.hash));
}, 5000);