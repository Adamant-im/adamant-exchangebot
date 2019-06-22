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
			{
				isFinished: false,
			},
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
			outAmount,
			inAmountMessage,
			sentBackAmount
		} = pay;

		let type,
			sendCurrency,
			sendTxId,
			sendAmount,
			etherString;

		if (pay.outTxid){
			type = 'exchange';
			sendCurrency = outCurrency;
			sendTxId = pay.outTxid;
			sendAmount = outAmount;
		} else {
			type = 'back';
			sendCurrency = inCurrency;
			sendTxId = pay.sentBackTx;
			sendAmount = sentBackAmount;
		}

		try {
			let msgNotify = null;
			let msgSendBack = null;

			if (!lastBlockNumber[sendCurrency]) {
				log.warn('Cannot get lastBlockNumber for ' + sendCurrency + '. Waiting for next try.');
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
				if (type === 'exchange') {
					pay.update({
						errorValidatorSend: 21,
						outTxid: null
					});

					msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies that exchange transfer of _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_ failed. Tx hash: _${sendTxId}_. Will try again. Balance of _${sendCurrency}_ is _${Store.user[sendCurrency].balance}_. ${etherString}Income ADAMANT Tx: _https://explorer.adamant.im/tx/${admTxId}_.`;				
					msgSendBack = `I’ve tried to make transfer of _${outAmount}_ _${outCurrency}_ to you, but it seems transaction failed. Tx hash: _${sendTxId}_. I will try again. If I’ve said the same several times already, please contact my master.`;

				} else {
					pay.update({
						errorValidatorSend: 22,
						sentBackTx: null
					});

					msgNotify = `Exchange Bot ${Store.user.ADM.address} sent back of _${inAmountMessage}_ _${inCurrency}_ failed. Tx hash: _${sendTxId}_. Will try again. Balance of _${sendCurrency}_ is _${Store.user[sendCurrency].balance}_. ${etherString}Income ADAMANT Tx: _https://explorer.adamant.im/tx/${admTxId}_.`;
					msgSendBack = `I’ve tried to send transfer back, but it seems transaction failed. Tx hash: _${sendTxId}_. I will try again. If I’ve said the same several times already, please contact my master.`;
				}

				$u.sendAdmMsg(pay.senderId, msgSendBack);

			} else if (status && pay.outConfirmations >= config.min_confirmations){

				if (type === 'exchange') {
					msgNotify = `Exchange Bot ${Store.user.ADM.address} successfully exchanged _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_ with Tx hash: _${sendTxId}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${admTxId}_.`;
					msgSendBack = `{"type":"${sendCurrency}_transaction","amount":"${sendAmount}","hash":"${sendTxId}","comments":"Done! Note, some amount spent to cover blockchain fees. Try me again!"}`;
				} else { // type === 'back'
					msgNotify = `Exchange Bot ${Store.user.ADM.address} successfully sent back _${inAmountMessage}_ _${inCurrency}_ with Tx hash: _${sendTxId}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${admTxId}_.`;
					msgSendBack = `{"type":"${sendCurrency}_transaction","amount":"${sendAmount}","hash":"${sendTxId}","comments":"Here is your refund. Note, some amount spent to cover blockchain fees. Try me again!"}`;
				}
				pay.isFinished = $u.sendAdmMsg(pay.senderId, msgSendBack);
			}

			await pay.save();

			if (msgNotify) {
				notify(msgNotify, 'warn');
			}
		} catch (e) {
			log.error('Error in sendedTxValidator module ', {type, sendAmount, sendCurrency, sendTxId}, e);
		}
	});

};
setInterval(() => {
	module.exports();
}, 15 * 1000);
