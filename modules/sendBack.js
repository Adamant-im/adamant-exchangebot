const db = require('./DB');
const config = require('./configReader');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const Store = require('./Store');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const api = require('./api');

module.exports = async () => {
	
	const {paymentsDb} = db;
	const pays = (await paymentsDb.find({
		transactionIsValid: true,
		isFinished: false,
		transactionIsFailed: false,
		needToSendBack: true,
		needHumanCheck: false,
		inTxStatus: true,
		outTxid: null,
		sentBackTx: null
	})).filter(p => p.inConfirmations >= config['min_confirmations_' + p.inCurrency]);

	for (const pay of pays){
		pay.counterSendBack = pay.counterSendBack || 0;
		const {
			inAmountReal,
			inCurrency,
			senderKvsInAddress
		} = pay;

		let msgSendBack = false;
		let msgNotify = false;
		let notifyType = 'log';

		let etherString = '';
		let isNotEnoughBalance;
		let outFee = exchangerUtils[inCurrency].FEE;
		let sentBackAmount;

		const inCryptoBalance = await exchangerUtils[inCurrency].getBalance();
		if (!inCryptoBalance) {
			log.warn(`Unable to update balance for ${inCurrency} in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
			return;
		}

		if (exchangerUtils.isERC20(inCurrency)) {
			const ethBalance = await exchangerUtils['ETH'].getBalance();
			if (!ethBalance) {
				log.warn(`Unable to update balance for ETH in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
				return;
			}
			etherString = `Ether balance: ${exchangerUtils['ETH'].balance}. `;
			sentBackAmount = +(inAmountReal - exchangerUtils[inCurrency].FEEinToken).toFixed(8);
			isNotEnoughBalance = (sentBackAmount > exchangerUtils[inCurrency].balance) || (exchangerUtils[inCurrency].FEE.inEth > exchangerUtils['ETH'].balance);
		} else {
			etherString = '';
			sentBackAmount = +(inAmountReal - outFee).toFixed(8);
			isNotEnoughBalance = sentBackAmount > exchangerUtils[inCurrency].balance;
		}

		const sentBackAmountUsd = Store.mathEqual(inCurrency, 'USD', sentBackAmount).outAmount;
		pay.update({
			outFee,
			sentBackAmount,
			sentBackAmountUsd
		});
		if (sentBackAmount <= 0){
			pay.update({
				errorSendBack: 17,
				isFinished: true
			});
			notifyType = 'log';
			msgNotify = `${config.notifyName} won’t send back payment of _${inAmountReal}_ _${inCurrency}_ because it is less than transaction fee. Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`;
			msgSendBack = 'I can’t send transfer back to you because it does not cover blockchain fees. If you think it’s a mistake, contact my master.';
		} else if (isNotEnoughBalance){
			notifyType = 'error';
			msgNotify = `${config.notifyName} notifies about insufficient balance for send back of _${inAmountReal}_ _${inCurrency}_. Attention needed. Balance of _${inCurrency}_ is _${exchangerUtils[inCurrency].balance}_. ${etherString}Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`;
			msgSendBack = 'I can’t send transfer back to you because of insufficient balance. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.';
			pay.update({
				errorSendBack: 18,
				needHumanCheck: true,
				isFinished: true
			});
		} else { // We are able to send transfer back
			const result = await exchangerUtils[inCurrency].send({
				address: senderKvsInAddress,
				value: sentBackAmount,
				comment: 'Here is your refund. Note, some amount spent to cover blockchain fees. Try me again!' // if ADM
			});

			if (result.success) {
				pay.sentBackTx = result.hash;

				if (exchangerUtils.isERC20(inCurrency)) {
					exchangerUtils[inCurrency].balance -= sentBackAmount;
					exchangerUtils['ETH'].balance -= outFee;
				} else {
					exchangerUtils[inCurrency].balance -= sentBackAmount;
				}

				log.info(`Successful send back of ${sentBackAmount} ${inCurrency}. Hash: ${result.hash}.`);
			} else { // Can't make a transaction

				if (++pay.counterSendBack < 50){
					pay.save();
					return;
				};

				pay.update({
					errorSendBack: 19,
					needHumanCheck: true,
					isFinished: true
				});
				notifyType = 'error';
				log.error(`Failed to send back of ${sentBackAmount} ${inCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`);
				msgNotify = `${config.notifyName} cannot make transaction to send back _${sentBackAmount}_ _${inCurrency}_. Attention needed. Balance of _${inCurrency}_ is _${exchangerUtils[inCurrency].balance}_. ${etherString}Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`;
				msgSendBack = 'I’ve tried to send back transfer to you, but something went wrong. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.';
			}
		}
		log.info(`[sendBack logs] Coin: ${inCurrency}, tx: ${pay.sentBackTx}, error: ${pay.errorSendBack}, balance: ${exchangerUtils[inCurrency].balance}, fee: ${outFee}, amount: ${sentBackAmount}, eqUsd: ${sentBackAmountUsd}`);
		pay.save();
		if (msgNotify){
			notify(msgNotify, notifyType);
		}
		if (msgSendBack){
			api.sendMessage(config.passPhrase, pay.senderId, msgSendBack);
		}
	}
};

setInterval(() => {
	module.exports();
}, 17 * 1000);
