const db = require('./DB');
const config = require('./configReader');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const api = require('./api');
const utils = require('../helpers/utils');

module.exports = async () => {

	const { paymentsDb } = db;
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
			outAmount,
			inAmountMessage,
			sentBackAmount
		} = pay;

		pay.tryCounterCheckOutTX = ++pay.tryCounterCheckOutTX || 0;
		
		let direction,
			sendCurrency,
			sendTxId,
			sendAmount,
			etherString,
			notifyType;

		if (pay.outTxid){
			direction = 'exchange';
			sendCurrency = outCurrency;
			sendTxId = pay.outTxid;
			sendAmount = outAmount;
		} else {
			direction = 'back';
			sendCurrency = inCurrency;
			sendTxId = pay.sentBackTx;
			sendAmount = sentBackAmount;
		}

		try {
			let msgNotify = null;
			let msgSendBack = null;

			if (exchangerUtils.isERC20(outCurrency)) {
				etherString = `Ether balance: ${exchangerUtils['ETH'].balance}. `;
			}

			const lastBlockHeight = await exchangerUtils[sendCurrency].getLastBlockHeight();
			if (!lastBlockHeight) {
				log.warn(`Unable get last block height for ${sendCurrency} in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
				return;
			}

			const txData = (await exchangerUtils[sendCurrency].getTransaction(sendTxId));
			if (!txData || !txData.height) {
				if (pay.tryCounterCheckOutTX > 50) {
					pay.update({
						errorCheckOuterTX: 24,
						isFinished: true,
						needHumanCheck: true
					});
					if (direction === 'exchange') {
						notifyType = 'error';
						msgNotify = `${config.notifyName} unable to verify exchange transfer of _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Insufficient balance? Attention needed. Tx hash: _${sendTxId}_. Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}Income ADAMANT Tx: https://explorer.adamant.im/tx/${admTxId}.`;
						msgSendBack = `I’ve tried to make transfer of _${outAmount}_ _${outCurrency}_ to you, but I cannot validate transaction. Tx hash: _${sendTxId}_. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.`;
	
					} else { // direction === 'back'
						notifyType = 'error';
						msgNotify = `${config.notifyName} unable to verify sent back of _${inAmountMessage} ${inCurrency}_. Insufficient balance? Attention needed. Tx hash: _${sendTxId}_. Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}Income ADAMANT Tx: https://explorer.adamant.im/tx/${admTxId}.`;
						msgSendBack = `I’ve tried to send back transfer to you, but I cannot validate transaction. Tx hash: _${sendTxId}_. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.`;
					}
					
					notify(msgNotify, notifyType);
					api.sendMessage(config.passPhrase, pay.senderId, msgSendBack);
				}
				pay.save();
				return;
			}
			const {status, height} = txData;

			if (!height) {
				return;
			}

			pay.update({
				outTxStatus: status,
				outConfirmations: lastBlockHeight - height
			});

			if (status === false) {
				notifyType = 'error';
				if (direction === 'exchange') {
					pay.update({
						errorValidatorSend: 21,
						outTxid: null
					});

					msgNotify = `${config.notifyName} notifies that exchange transfer of _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_ failed. Tx hash: _${sendTxId}_. Will try again. Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}Income ADAMANT Tx: https://explorer.adamant.im/tx/${admTxId}.`;
					msgSendBack = `I’ve tried to make transfer of _${outAmount}_ _${outCurrency}_ to you, but it seems transaction failed. Tx hash: _${sendTxId}_. I will try again. If I’ve said the same several times already, please contact my master.`;

				} else {
					pay.update({
						errorValidatorSend: 22,
						sentBackTx: null
					});

					msgNotify = `${config.notifyName} sent back of _${inAmountMessage} ${inCurrency}_ failed. Tx hash: _${sendTxId}_. Will try again. Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}Income ADAMANT Tx: https://explorer.adamant.im/tx/${admTxId}.`;
					msgSendBack = `I’ve tried to send transfer back, but it seems transaction failed. Tx hash: _${sendTxId}_. I will try again. If I’ve said the same several times already, please contact my master.`;
				}

				api.sendMessage(config.passPhrase, pay.senderId, msgSendBack);

			} else if (status && pay.outConfirmations >= config['min_confirmations_' + sendCurrency]){

				if (direction === 'exchange') {
					notifyType = 'info';
					msgNotify = `${config.notifyName} successfully exchanged _${inAmountMessage} ${inCurrency}_ for _${outAmount} ${outCurrency}_ with Tx hash: _${sendTxId}_. Income ADAMANT Tx: https://explorer.adamant.im/tx/${admTxId}.`;
					msgSendBack = 'Done! Thank you for business. Hope to see you again.';

				} else { // direction === 'back'
					notifyType = 'log';
					msgNotify = `${config.notifyName} successfully sent back _${inAmountMessage} ${inCurrency}_ with Tx hash: _${sendTxId}_. Income ADAMANT Tx: https://explorer.adamant.im/tx/${admTxId}.`;
					msgSendBack = 'Here is your refund. Note, some amount spent to cover blockchain fees. Try me again!';
				}

				if (sendCurrency !== 'ADM'){
					msgSendBack = `{"type":"${sendCurrency}_transaction","amount":"${sendAmount}","hash":"${sendTxId}","comments":"${msgSendBack}"}`;
					pay.isFinished = await api.sendMessage(config.passPhrase, pay.senderId, msgSendBack, 'rich').success;
				} else {
					pay.isFinished = true;
				}
			}
			await pay.save();

			if (msgNotify) {
				notify(msgNotify, notifyType);
			}
		} catch (e) {
			log.error('Error in sentTxChecker module ', {direction, sendAmount, sendCurrency, sendTxId}, e);
		}
	});

};
setInterval(() => {
	module.exports();
}, 15 * 1000);
