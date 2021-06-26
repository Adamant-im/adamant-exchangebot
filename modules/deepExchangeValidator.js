const log = require('../helpers/log');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const notify = require('../helpers/notify');
const config = require('./configReader');
const db = require('./DB');
const api = require('./api');
const utils = require('../helpers/utils');

module.exports = async (pay, tx) => {
	pay.counterTxDeepValidator = ++pay.counterTxDeepValidator || 0;
	if (!tx){
		pay.save();
		return;
	}
	// Fetching addresses from ADAMANT KVS
	try {
		let senderKvsInAddress = pay.senderKvsInAddress || pay.inCurrency === 'ADM' && tx.senderId ||
			await exchangerUtils.getKvsCryptoAddress(pay.inCurrency, tx.senderId);
		let senderKvsOutAddress = pay.senderKvsOutAddress || pay.outCurrency === 'ADM' && tx.senderId ||
			await exchangerUtils.getKvsCryptoAddress(pay.outCurrency, tx.senderId);

		pay.update({
			senderKvsInAddress,
			senderKvsOutAddress
		});

		if (!senderKvsInAddress || !senderKvsOutAddress && !pay.needToSendBack){
			log.error(`Can't get address from KVS. In address: ${senderKvsInAddress}, out address: ${senderKvsOutAddress}. Will try next time.`);
			pay.save();
			return;
		}

		let notifyType = 'log';
		if (senderKvsInAddress === 'none') {
			pay.update({
				error: 8,
				isFinished: true,
				needHumanCheck: true
			}, true);
			notifyType = 'error';
			notify(`${config.notifyName} cannot fetch address from KVS for crypto: _${pay.inCurrency}_. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}. Attention needed.`, 'error');
			api.sendMessage(config.passPhrase, tx.senderId, `I can’t get your _${pay.inCurrency}_ address from ADAMANT KVS. If you think it’s a mistake, contact my master.`);
			return;
		};

		let msgSendBack = false;
		let msgNotify = false;
		if (senderKvsOutAddress === 'none' && !pay.needToSendBack) {
			pay.update({
				needToSendBack: true,
				error: 9
			});
			notifyType = 'warn';
			msgNotify = `${config.notifyName} cannot fetch address from KVS for crypto: _${pay.outCurrency}_. Will try to send payment back.`;
			msgSendBack = `I can’t get your _${pay.outCurrency}_ address from ADAMANT KVS. Make sure you use ADAMANT wallet with _${pay.outCurrency}_ enabled. Now I will try to send transfer back to you. I will validate your transfer and wait for _${config['min_confirmations_' + pay.inCurrency]}_ block confirmations. It can take a time, please be patient.`;
		}

		// Validating incoming TX in blockchain of inCurrency
		try {
			const in_tx = await exchangerUtils[pay.inCurrency].syncGetTransaction(pay.inTxid, tx);
			if (!in_tx) {
				if (pay.counterTxDeepValidator < 20){
					pay.save();
					return;
				}
				pay.update({
					transactionIsValid: false,
					isFinished: true,
					error: 10
				});
				notifyType = 'warn';
				msgNotify = `${config.notifyName} can’t fetch transaction of _${pay.inAmountMessage} ${pay.inCurrency}_.`;
				msgSendBack = `I can’t get transaction of _${pay.in_amount_message} ${pay.inCurrency}_ with Tx ID _${pay.inTxid}_ from _ ${pay.inCurrency}_ blockchain. It might be failed or cancelled. If you think it’s a mistake, contact my master.`;
			} else {
				pay.update({
					senderId: in_tx.senderId,
					recipientId: in_tx.recipientId,
					inAmountReal: in_tx.amount
				});

				if (String(pay.senderId).toLowerCase() !== String(pay.senderKvsInAddress).toLowerCase()) {
					pay.update({
						transactionIsValid: false,
						isFinished: true,
						error: 11
					});
					notifyType = 'warn';
					msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Sender expected: _${senderKvsInAddress}_, but real sender is _${pay.senderId}_.`;
					msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
				} else if (String(pay.recipientId).toLowerCase() !== exchangerUtils[pay.inCurrency].account.address.toLowerCase()) {
					pay.update({
						transactionIsValid: false,
						isFinished: true,
						error: 12
					});
					notifyType = 'warn';
					msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Recipient expected: _${exchangerUtils[pay.inCurrency].account.address}_, but real recipient is _${pay.recipientId}_.`;
					msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
				} else if (Math.abs(pay.inAmountReal - pay.inAmountMessage) > pay.inAmountReal * 0.005) {
					pay.update({
						transactionIsValid: false,
						isFinished: true,
						error: 13
					});
					notifyType = 'warn';
					msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Amount expected: _${pay.inAmountMessage}_, but real amount is _${pay.inAmountReal}_.`;
					msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
				} else { // Transaction is valid
					pay.update({
						transactionIsValid: true,
						inConfirmations: 0
					});
				}
			}
		} catch (e) {
			log.error('Error while validating non-ADM transaction: ' + e);
		}

		await pay.save();
		if (msgSendBack) {
			notify(msgNotify + ` Tx hash: _${pay.inTxid}_. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`, notifyType);
			api.sendMessage(config.passPhrase, tx.senderId, msgSendBack);
		}
	} catch (e) {
		log.error('Error in deepExchangeValidator module: ' + e);
	}
};

setInterval(async ()=>{
	const {paymentsDb} = db;
	(await paymentsDb.find({
		transactionIsValid: null,
		isFinished: false
	})).forEach(async pay => {
		const tx = await api.get('transactions/get', { id: pay.admTxId });
		if (tx.success) {
			module.exports(pay, tx.data.transaction);
		} else {
			module.exports(pay, null);
			log.warn(`Unable to fetch Tx ${pay.admTxId} in setInterval() of ${utils.getModuleName(module.id)} module. ${tx.errorMessage}.`);
		}
	});
}, 30 * 1000);
