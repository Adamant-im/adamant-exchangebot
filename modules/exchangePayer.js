const db = require('./DB');
const config = require('./configReader');
const constants = require('../helpers/const');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const api = require('./api');

module.exports = async () => {

	const { paymentsDb } = db;
	(await paymentsDb.find({
		transactionIsValid: true,
		isFinished: false,
		transactionIsFailed: false,
		needToSendBack: false,
		needHumanCheck: false,
		inTxStatus: true,
		outTxid: null
	})).filter(p => p.inConfirmations >= config['min_confirmations_' + p.inCurrency])
		.forEach(async pay => {

			const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay.itxId} from ${pay.senderId}`;
			try {

				pay.counterSendExchange = ++pay.counterSendExchange || 1;
				log.log(`Sending exchange payment of ${pay.inAmountMessage} ${pay.inCurrency} for ${pay.outAmount} ${pay.outCurrency}. Attempt ${pay.counterSendExchange}… ${admTxDescription}.`);

				const {
					outAmount,
					inCurrency,
					outCurrency,
					senderKvsOutAddress,
					inAmountMessage
				} = pay;

				let etherString = '';
				let isNotEnoughBalance;
				let msgSendBack;
				let msgNotify;

				const outCurrencyBalance = await exchangerUtils[outCurrency].getBalance();
				if (!outCurrencyBalance) {
					log.warn(`Unable to update balance for ${outCurrency} in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
					return;
				}

				if (exchangerUtils.isERC20(outCurrency)) {
					const ethBalance = await exchangerUtils['ETH'].getBalance();
					if (!ethBalance) {
						log.warn(`Unable to update balance for ETH in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
						return;
					}
					etherString = `Ether balance: ${ethBalance}. `;
					isNotEnoughBalance = (outAmount > outCurrencyBalance) || (exchangerUtils[outCurrency].FEE > ethBalance);
				} else {
					etherString = '';
					isNotEnoughBalance = outAmount + exchangerUtils[outCurrency].FEE > outCurrencyBalance;
				}

				if (isNotEnoughBalance) {
					pay.update({
						error: 15,
						needToSendBack: true
					}, true);
					msgNotify = `${config.notifyName} notifies about insufficient balance to exchange _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Will try to send payment back. Balance of _${outCurrency}_ is _${exchangerUtils[outCurrency].balance}_. ${etherString}${admTxDescription}.`;
					msgSendBack = `I can’t transfer _${outAmount}_ _${outCurrency}_ to you because of insufficient funds (I count blockchain fees also). Check my balances with **/balances** command. I'll send transfer back to you.`;
					notify(msgNotify, 'warn');
					api.sendMessage(config.passPhrase, pay.senderId, msgSendBack).then(response => {
						if (!response.success)
							log.warn(`Failed to send ADM message '${msgSendBack}' to ${pay.senderId}. ${response.errorMessage}.`);
					});
					return;
				}

				const result = await exchangerUtils[outCurrency].send({
					address: senderKvsOutAddress,
					value: outAmount,
					comment: 'Done! Thank you for business. Hope to see you again.', // if ADM
					try: pay.outTxFailedCounter + 1
				});

				if (result.success) {
					pay.update({
						outTxid: result.hash
					}, true);
					// Update local balances without unnecessary requests
					if (exchangerUtils.isERC20(outCurrency)) {
						exchangerUtils[outCurrency].balance -= outAmount;
						exchangerUtils['ETH'].balance -= exchangerUtils[outCurrency].FEE;
					} else {
						exchangerUtils[outCurrency].balance -= (outAmount + exchangerUtils[outCurrency].FEE);
					}
				} else { // Can't make a transaction
					if (pay.counterSendExchange < constants.EXCHANGER_RETRIES) {
						log.warn(`Unable to send exchange payment of ${pay.inAmountMessage} ${pay.inCurrency} for ${pay.outAmount} ${pay.outCurrency} this time. Will try again. ${admTxDescription}.`);
						pay.save();
						return;
					};
					pay.update({
						error: 16,
						needToSendBack: true,
					}, true);
					msgNotify = `${config.notifyName} cannot make transaction to exchange _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Will try to send payment back. Balance of _${outCurrency}_ is _${exchangerUtils[outCurrency].balance}_. ${etherString}${admTxDescription}.`;
					msgSendBack = `I’ve tried to make transfer of _${outAmount}_ _${outCurrency}_ to you, but something went wrong. I'll send payment back to you.`;
					notify(msgNotify, 'error');
					api.sendMessage(config.passPhrase, pay.senderId, msgSendBack).then(response => {
						if (!response.success)
							log.warn(`Failed to send ADM message '${msgSendBack}' to ${pay.senderId}. ${response.errorMessage}.`);
					});
				}

			} catch (e) {
				log.error(`Error while sending exchange payment of ${pay.inAmountMessage} ${pay.inCurrency} for ${pay.outAmount} ${pay.outCurrency} in ${utils.getModuleName(module.id)} module. ${admTxDescription}. Error: ` + e);
			}

		});
};

setInterval(() => {
	module.exports();
}, constants.EXCHANGER_INTERVAL);
