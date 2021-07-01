const db = require('./DB');
const config = require('./configReader');
const constants = require('../helpers/const');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const api = require('./api');
const utils = require('../helpers/utils');

module.exports = async () => {

	const { paymentsDb } = db;
	(await paymentsDb.find({
		$and: [
			{ isFinished: false },
			{
				$or: [
					{ outTxid: { $ne: null } },
					{ sentBackTx: { $ne: null } },
				]
			}
		]
	})).forEach(async pay => {

		pay.tryCounterCheckOutTX = ++pay.tryCounterCheckOutTX || 0;

		let direction,
			sendCurrency,
			sendTxId,
			sendAmount,
			etherString,
			notifyType;

		if (pay.outTxid) {
			direction = 'exchange';
			sendCurrency = pay.outCurrency;
			sendTxId = pay.outTxid;
			sendAmount = pay.outAmount;
		} else {
			direction = 'back';
			sendCurrency = pay.inCurrency;
			sendTxId = pay.sentBackTx;
			sendAmount = pay.sentBackAmount;
		}

		const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay.admTxId} from ${pay.senderId}`;

		try {

			log.log(`Updating sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} confirmations… ${admTxDescription}.`)

			let msgNotify = null;
			let msgSendBack = null;

			if (exchangerUtils.isERC20(sendCurrency)) {
				etherString = `Ether balance: ${exchangerUtils['ETH'].balance}. `;
			}

			const tx = await exchangerUtils[sendCurrency].getTransaction(sendTxId);
			if (!tx) {
				log.warn(`Unable to fetch sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency}. It's expected, if the Tx is new. Will try again next time. ${admTxDescription}.`);
				if (pay.tryCounterCheckOutTX > constants.SENDER_GET_TX_RETRIES) {
					pay.update({
						errorCheckOuterTX: constants.ERRORS.UNABLE_TO_FETCH_SENT_TX,
						isFinished: true,
						needHumanCheck: true
					});
					if (direction === 'exchange') {
						notifyType = 'error';
						msgNotify = `${config.notifyName} unable to verify exchange transfer of _${sendAmount}_ _${sendCurrency}_ (got _${pay.inAmountMessage}_ _${pay.inCurrency}_ from user). Insufficient balance? Attention needed. Tx hash: _${sendTxId}_. Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}${admTxDescription}.`;
						msgSendBack = `I’ve tried to make transfer of _${sendAmount}_ _${sendCurrency}_ to you, but I cannot validate transaction. Tx hash: _${sendTxId}_. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.`;
					} else { // direction === 'back'
						notifyType = 'error';
						msgNotify = `${config.notifyName} unable to verify sent back of _${sendAmount}_ _${sendCurrency}_. Insufficient balance? Attention needed. Tx hash: _${sendTxId}_. Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}${admTxDescription}.`;
						msgSendBack = `I’ve tried to send back transfer to you, but I cannot validate transaction. Tx hash: _${sendTxId}_. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.`;
					}
					notify(msgNotify, notifyType);
					api.sendMessage(config.passPhrase, pay.senderId, msgSendBack);
				}
				pay.save();
				return;
			}

			if (!tx.height && !tx.confirmations) {
				log.warn(`Unable to get sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} height and confirmations. Will try again next time. ${admTxDescription}.`);
				return;
			}

			let confirmations = tx.confirmations;
			if (!tx.confirmations) {
				const lastBlockHeight = await exchangerUtils[sendCurrency].getLastBlockHeight();
				if (!lastBlockHeight) {
					log.warn(`Unable to get last block height for ${sendCurrency} to count Tx ${sendTxId} confirmations in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
					return;
				}
				confirmations = lastBlockHeight - tx.height;
			}
	
			pay.update({
				outTxStatus: tx.status,
				outConfirmations: confirmations
			});

			if (pay.outTxStatus === false) {

				notifyType = 'error';
				if (direction === 'exchange') {
					pay.update({
						errorValidatorSend: constants.ERRORS.SENT_EXCHANGE_TX_FAILED,
						outTxid: null
					});
					msgNotify = `${config.notifyName} notifies that exchange transfer of _${sendAmount}_ _${sendCurrency}_ (got _${pay.inAmountMessage}_ _${pay.inCurrency}_ from user) **failed**. Tx hash: _${sendTxId}_. Will try again. Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}${admTxDescription}.`;
					msgSendBack = `I’ve tried to make transfer of _${sendAmount}_ _${sendCurrency}_ to you, but it seems transaction failed. Tx hash: _${sendTxId}_. I will try again. If I’ve said the same several times already, please contact my master.`;
				} else { // direction === 'back'
					pay.update({
						errorValidatorSend: constants.ERRORS.SENT_BACK_TX_FAILED,
						sentBackTx: null
					});
					msgNotify = `${config.notifyName} sent back of _${sendAmount}_ _${sendCurrency}_ **failed**. Tx hash: _${sendTxId}_. Will try again. Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}${admTxDescription}.`;
					msgSendBack = `I’ve tried to send transfer back, but it seems transaction failed. Tx hash: _${sendTxId}_. I will try again. If I’ve said the same several times already, please contact my master.`;
				}
				api.sendMessage(config.passPhrase, pay.senderId, msgSendBack);

			} else if (pay.inTxStatus && pay.outConfirmations >= config['min_confirmations_' + sendCurrency]) {

				if (direction === 'exchange') {
					notifyType = 'info';
					msgNotify = `${config.notifyName} successfully exchanged _${pay.inAmountMessage} ${pay.inCurrency}_ (got from user) for _${pay.outAmount} ${pay.outCurrency}_ (sent to user) with Tx hash: _${sendTxId}_. ${admTxDescription}.`;
					msgSendBack = 'Done! Thank you for business. Hope to see you again.';
				} else { // direction === 'back'
					notifyType = 'log';
					msgNotify = `${config.notifyName} successfully sent back _${sendAmount} ${sendCurrency}_ with Tx hash: _${sendTxId}_. ${admTxDescription}.`;
					msgSendBack = `Here is your refund. Note, I've spent some to cover blockchain fees. Try me again!`;
				}

				if (sendCurrency !== 'ADM') {
					msgSendBack = `{"type":"${sendCurrency.toLowerCase()}_transaction","amount":"${sendAmount}","hash":"${sendTxId}","comments":"${msgSendBack}"}`;
					let message = await api.sendMessage(config.passPhrase, pay.senderId, msgSendBack, 'rich').success;
					if (message.success) {
						pay.isFinished = true;
					} else {
						log.warn(`Failed to send ADM message on sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} to ${pay.senderId}. I will try again. ${message.errorMessage}.`);
					}
				} else {
					pay.isFinished = true;
				}
			}

			await pay.save();

			if (msgNotify) {
				notify(msgNotify, notifyType);
			}

		} catch (e) {
			log.error(`Failed to check sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency}: ${e.toString()}. Will try again next time. ${admTxDescription}.`)
		}

	});

};

setInterval(() => {
	module.exports();
}, constants.SENDER_TX_INTERVAL);
