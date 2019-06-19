const db = require('./DB');
const config = require('./configReader');
const $u = require('../helpers/utils');
const Store = require('./Store');
const log = require('../helpers/log');
const notify = require('../helpers/notify');

module.exports = async () => {
	const {paymentsDb} = db;
	const lastBlockNumber = {
		ETH: await $u.ETH.getLastBlockNumber(),
		ADM: await $u.ADM.getLastBlockNumber(),
	};

	(await paymentsDb.find({
		$and: [
			{isFinished: false},
			{$or: [
				{outTxid: {$ne: null}},
				{sentBackTx: {$ne: null}},
			]}
		]
	})).forEach(async pay => {
		const {
			inCurrency,
			outCurrency,
			admTxId,
			inAmountMessage,
			sentBackAmount
		} = pay;
		const sendCurrency = pay.outTxid ? outCurrency : inCurrency;
		const type = pay.outTxid ? 'exchange' : 'back';
		const sendTxId = pay.outTxid || pay.sentBackTx;
		const sendAmount = sentBackAmount || inAmountMessage;
		try {
			let msgNotify = null;
			let msgSendBack = null;

			if (!lastBlockNumber[sendCurrency]) {
				log.warn('Miss confirmation, no defined lastBlockNumber ' + sendCurrency);
				return;
			}
			const {status, blockNumber} = (await $u[sendCurrency].getTransactionStatus(sendTxId));
			if (!blockNumber) {
				return;
			}
	
			pay.update({
				outTxStatus: status,
				outConfirmations: lastBlockNumber[sendCurrency] - blockNumber
			});
			
			if (status === false) {
				pay.update({
					error: 21,
					isFinished: true
				});
				msgNotify = `Exchange Bot ${Store.user.ADM.address} sent ${type} of _${inAmountMessage}_ _${inCurrency}_ failed. Tx hash: _${sendTxId}_. Will try again. Balance of _${sendCurrency}_ is ${Store.user[sendCurrency].balance}. <ether_string> Income ADAMANT Tx: _https://explorer.adamant.im/tx/${admTxId}`;
				
				msgSendBack = `I’ve tried to send transfer back, but it seems transaction failed. Tx hash: _${sendTxId}_. I will try again. If I’ve said the same several times already, please contact my master.`;
			} else if (status && pay.outConfirmations >= config.min_confirmations){
				msgNotify = `Exchange Bot ${Store.user.ADM.address} successfully sent ${type} _${inAmountMessage}_ _${inCurrency}_ with Tx hash: _${sendTxId}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${admTxId}_.`;
				msgSendBack = `{"type":"${sendCurrency}_transaction","amount":${sendAmount},"hash":"${sendTxId}","comments":"Note, some amount spent to cover blockchain fees. Try me again!"}`;
				pay.isFinished = true;
			}

			await pay.save();
			if (msgSendBack) {
				notify(msgNotify, 'warn');
				$u.sendAdmMsg(pay.senderId, msgSendBack);
			}
		} catch (e) {
			log.error(`Error in sendedTxValidator module (${sendCurrency} ${sendTxId}) ${e}`);
		}
	});

};
setInterval(() => {
	module.exports();
}, 15 * 1000);