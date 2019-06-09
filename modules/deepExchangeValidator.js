const api = require('./api');
const log = require('../helpers/log');
const $u = require('../helpers/utils');
const notify = require('../helpers/notify');
const Store = require('./Store');
const config = require('./configReader');

module.exports = async (pay, tx) => {
	pay.tryCounter++;

	try {
		let sender_kvs_in_address = pay.sender_kvs_in_address || pay.inCurrency === 'ADM' && tx.senderId ||
			await $u.getAddressCryptoFromAdmAddressADM(pay.inCurrency, tx.senderId);
		let sender_kvs_out_address = pay.sender_kvs_out_address || pay.outCurrency === 'ADM' && tx.senderId ||
			await $u.getAddressCryptoFromAdmAddressADM(pay.outCurrency, tx.senderId);

		pay.update({
			sender_kvs_in_address,
			sender_kvs_out_address
		});

		if (!sender_kvs_in_address) {
			pay.update({
				error: 8,
				isFinished: true,
				needHumanCheck: true
			}, true);
			notify(`Exchange Bot ${Store.user.ADM.address} cannot fetch address from KVS for crypto: ${pay.inCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`, 'error');
			$u.sendAdmMsg(tx.senderId, `I can’t get your ${pay.inCurrency} address from KVS. If you think it’s a mistake, contact my master`);
			return;
		};

		let msgSendBack = false;
		let msgNotify = false;
		if (!sender_kvs_out_address && !pay.needToSendBack) {
			pay.update({
				needToSendBack: true,
				error: 9
			});
			msgNotify = `Exchange Bot ${Store.user.ADM.address} cannot fetch address from KVS for crypto: ${pay.outCurrency}.`;
			msgSendBack = `I can’t get your ${pay.outCurrency} address from KVS. Make sure you use ADAMANT wallet with ${pay.inCurrency} enabled. Now I will try to send transfer back to you. I will validate your transfer and wait for ${config.min_confirmations} block confirmations. It can take a time, please be patient.`;
		}

		// check incoming TX in blockchain inCurrency
		if (pay.inCurrency !== 'ADM') {
			try {
				const in_tx = await $u[pay.inCurrency + '_syncGetTransaction'](pay.inTxid);
				if (!in_tx) { // TODO: ??????????
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

					if (pay.sender !== pay.sender_kvs_in_address) {
						pay.update({
							transactionIsValid: false,
							isFinished: true,
							error: 11
						});
						msgNotify = `Exchange Bot ${Store.user.ADM.address} thinks transaction of ${pay.inAmountMessage} ${pay.inCurrency} is wrong. Sender expected: ${sender_kvs_in_address}, real sender is ${pay.sender}.`;

						msgSendBack = `I can’t validate transaction of ${pay.inAmountMessage} ${pay.inCurrency} with Tx ID ${pay.inTxid}. If you think it’s a mistake, contact my master`;

					} else if (pay.recipient !== Store.user[pay.inCurrency].address) {
						pay.update({
							transactionIsValid: false,
							isFinished: true,
							error: 12
						});

						msgNotify = `Exchange Bot ${Store.user.ADM.address} thinks transaction of ${pay.inAmountMessage} ${pay.inCurrency} is wrong. Recipient expected: ${pay.outCurrency}, real recipient is ${pay.recipient}.`;

						msgSendBack = `I can’t validate transaction of ${pay.inAmountMessage} ${pay.inCurrency} with Tx ID ${pay.inTxid}. If you think it’s a mistake, contact my master`;

					} else if (Math.abs(pay.inAmountReal - pay.inAmountMessage) > pay.inAmountReal * 0.005) {
						pay.update({
							transactionIsValid: false,
							isFinished: true,
							error: 13
						});
						msgNotify = `Exchange Bot ${Store.user.ADM.address} thinks transaction of ${pay.inAmountMessage} ${pay.inCurrency} is wrong. Amount expected: ${pay.inAmountMessage}, real amount is ${pay.inAmountReal}.`;

						msgSendBack = `I can’t validate transaction of ${pay.inAmountMessage} ${pay.inCurrency} with Tx ID ${pay.inTxid}. If you think it’s a mistake, contact my master`;

					} else { // its Ok
						pay.transactionIsValid = true;
					}
				}
			} catch (e) {
				log.error('Error deep validate no ADM incoming coins ' + e);
			}
		} else { // inCurrency is ADM
			pay.transactionIsValid = true;
		}

		await pay.save();

		if (msgSendBack) {
			notify(msgNotify + `Tx hash: ${pay.inTxid}. Tx hash: ${pay.inTxid}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}`, 'warn');
			$u.sendAdmMsg(tx.senderId, msgSendBack);
		}
	} catch (e) {
		log.error('deepExchangeValidator ' + e);
	}
};
