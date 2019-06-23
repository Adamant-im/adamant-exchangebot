const api = require('./api');
const log = require('../helpers/log');
const $u = require('../helpers/utils');
const notify = require('../helpers/notify');
const Store = require('./Store');
const config = require('./configReader');

module.exports = async (pay, tx) => {
	pay.counterTxDeepValidator = pay.counterTxDeepValidator || 0;
	// Fetching addresses from ADAMANT KVS
	try {
		let senderKvsInAddress = pay.senderKvsInAddress || pay.inCurrency === 'ADM' && tx.senderId ||
			await $u.getAddressCryptoFromAdmAddressADM(pay.inCurrency, tx.senderId);
		let senderKvsOutAddress = pay.senderKvsOutAddress || pay.outCurrency === 'ADM' && tx.senderId ||
			await $u.getAddressCryptoFromAdmAddressADM(pay.outCurrency, tx.senderId);

		pay.update({
			senderKvsInAddress,
			senderKvsOutAddress
		});

		if (!senderKvsInAddress) {
			pay.update({
				error: 8,
				isFinished: true,
				needHumanCheck: true
			}, true);
			notify(`Exchange Bot ${Store.user.ADM.address} cannot fetch address from KVS for crypto: _${pay.inCurrency}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${tx.id}_.`, 'error');
			$u.sendAdmMsg(tx.senderId, `I can’t get your _${pay.inCurrency}_ address from ADAMANT KVS. If you think it’s a mistake, contact my master.`);
			return;
		};

		let msgSendBack = false;
		let msgNotify = false;
		if (!senderKvsOutAddress && !pay.needToSendBack) {
			pay.update({
				needToSendBack: true,
				error: 9
			});
			msgNotify = `Exchange Bot ${Store.user.ADM.address} cannot fetch address from KVS for crypto: _${pay.outCurrency}_.`;
			msgSendBack = `I can’t get your _${pay.outCurrency}_ address from ADAMANT KVS. Make sure you use ADAMANT wallet with _${pay.outCurrency}_ enabled. Now I will try to send transfer back to you. I will validate your transfer and wait for _${config['min_confirmations_' + pay.outCurrency]}_ block confirmations. It can take a time, please be patient.`;
		}

		// Validating incoming TX in blockchain of inCurrency
		try {
			const in_tx = await $u[pay.inCurrency].syncGetTransaction(pay.inTxid, tx);
			if (!in_tx) { // TODO: ?????????? Add counter and error message
				if (pay.counterTxDeepValidator++ < 20){
					pay.save();
					return;
				}
				pay.update({
					needHumanCheck: true,
					isFinished: true,
					error: 10
				});
			} else {
				pay.update({
					sender: in_tx.sender,
					recipient: in_tx.recipient,
					inAmountReal: in_tx.amount
				});

				if (pay.sender.toLowerCase() !== pay.senderKvsInAddress.toLowerCase()) {
					pay.update({
						transactionIsValid: false,
						isFinished: true,
						error: 11
					});
					msgNotify = `Exchange Bot ${Store.user.ADM.address} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Sender expected: _${senderKvsInAddress}_, but real sender is _${pay.sender}_.`;
					msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
				} else if (pay.recipient.toLowerCase() !== Store.user[pay.inCurrency].address.toLowerCase()) {
					pay.update({
						transactionIsValid: false,
						isFinished: true,
						error: 12
					});
					msgNotify = `Exchange Bot ${Store.user.ADM.address} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Recipient expected: _${Store.user[pay.inCurrency].address}_, but real recipient is _${pay.recipient}_.`;
					msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
				} else if (Math.abs(pay.inAmountReal - pay.inAmountMessage) > pay.inAmountReal * 0.005) {
					pay.update({
						transactionIsValid: false,
						isFinished: true,
						error: 13
					});
					msgNotify = `Exchange Bot ${Store.user.ADM.address} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Amount expected: _${pay.inAmountMessage}_, but real amount is _${pay.inAmountReal}_.`;
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
			notify(msgNotify + ` Tx hash: _${pay.inTxid}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${tx.id}_.`, 'warn');
			$u.sendAdmMsg(tx.senderId, msgSendBack);
		}
	} catch (e) {
		log.error('Error in deepExchangeValidator module: ' + e);
	}
};
