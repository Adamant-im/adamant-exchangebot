const db = require('./DB');
const config = require('./configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const constants = require('../helpers/const');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const api = require('./api');

module.exports = async () => {

	const { paymentsDb } = db;
	const pays = (await paymentsDb.find({
		isBasicChecksPassed: true,
		transactionIsValid: true,
		inTxConfirmed: true,
		isFinished: false,
		transactionIsFailed: false,
		needToSendBack: true,
		needHumanCheck: false,
		outTxid: null,
		sentBackTx: null
	}));

	for (const pay of pays) {

		const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay.itxId} from ${pay.senderId}`;
		try {

			pay.counterSendBack = ++pay.counterSendBack || 1;
			log.log(`Sending back ${pay.inAmountReal} ${pay.inCurrency}. Attempt ${pay.counterSendBack}… ${admTxDescription}.`);

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

			const inCurrencyBalance = await exchangerUtils[inCurrency].getBalance();
			if (!inCurrencyBalance) {
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
				let FEEinToken = exchangerUtils.convertCryptos('ETH', inCurrency, exchangerUtils[inCurrency].FEE).outAmount;
				sentBackAmount = +(inAmountReal - FEEinToken).toFixed(constants.PRECISION_DECIMALS);
				isNotEnoughBalance = (sentBackAmount > exchangerUtils[inCurrency].balance) || (FEEinToken > exchangerUtils['ETH'].balance);
			} else {
				etherString = '';
				sentBackAmount = +(inAmountReal - outFee).toFixed(constants.PRECISION_DECIMALS);
				isNotEnoughBalance = sentBackAmount > exchangerUtils[inCurrency].balance;
			}

			const sentBackAmountUsd = exchangerUtils.convertCryptos(inCurrency, 'USD', sentBackAmount).outAmount;
			pay.update({
				outFee,
				sentBackAmount,
				sentBackAmountUsd
			});
			if (sentBackAmount <= 0) {
				pay.update({
					errorSendBack: 17,
					isFinished: true
				});
				notifyType = 'log';
				msgNotify = `${config.notifyName} won’t send back payment of _${inAmountReal}_ _${inCurrency}_ because it is less than transaction fee. ${admTxDescription}.`;
				msgSendBack = 'I can’t send transfer back to you because it does not cover blockchain fees. If you think it’s a mistake, contact my master.';
			} else if (isNotEnoughBalance) {
				notifyType = 'error';
				msgNotify = `${config.notifyName} notifies about insufficient balance for send back of _${inAmountReal}_ _${inCurrency}_. **Attention needed**. Balance of _${inCurrency}_ is _${exchangerUtils[inCurrency].balance}_. ${etherString}${admTxDescription}.`;
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
					comment: 'Here is your refund. Note, some amount spent to cover blockchain fees. Try me again!', // if ADM
					try: pay.outTxFailedCounter + 1
				});

				if (result.success) {
					pay.sentBackTx = result.hash;
					if (exchangerUtils.isERC20(inCurrency)) {
						exchangerUtils[inCurrency].balance -= sentBackAmount;
						exchangerUtils['ETH'].balance -= outFee;
					} else {
						exchangerUtils[inCurrency].balance -= sentBackAmount;
					}
				} else { // Can't make a transaction
					if (pay.counterSendBack < constants.SENDBACK_RETRIES) {
						log.warn(`Unable to send back ${sentBackAmount} ${inCurrency} this time. Will try again. ${admTxDescription}.`);
						pay.save();
						return;
					};
					pay.update({
						errorSendBack: 19,
						needHumanCheck: true,
						isFinished: true
					});
					notifyType = 'error';
					msgNotify = `${config.notifyName} cannot make transaction to send back _${sentBackAmount}_ _${inCurrency}_. **Attention needed**. Balance of _${inCurrency}_ is _${exchangerUtils[inCurrency].balance}_. ${etherString}${admTxDescription}.`;
					msgSendBack = 'I’ve tried to send back transfer to you, but something went wrong. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.';
				}
			}

			pay.save();
			if (msgNotify) {
				notify(msgNotify, notifyType);
			}
			if (msgSendBack) {
				api.sendMessage(config.passPhrase, pay.senderId, msgSendBack).then(response => {
					if (!response.success)
						log.warn(`Failed to send ADM message '${msgSendBack}' to ${pay.senderId}. ${response.errorMessage}.`);
				});
			}

		} catch (e) {
			log.error(`Error while sending back ${pay.inAmountReal} ${pay.inCurrency} in ${utils.getModuleName(module.id)} module. ${admTxDescription}. Error: ` + e);
		}

	}
};

setInterval(() => {
	module.exports();
}, constants.SENDBACK_INTERVAL);
