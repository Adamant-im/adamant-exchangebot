const db = require('./DB');
const config = require('./configReader');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const api = require('./api');

module.exports = async () => {

	const {paymentsDb} = db;
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
			pay.counterSendExchange = pay.counterSendExchange || 0;
			const {
				outAmount,
				inCurrency,
				outCurrency,
				senderKvsOutAddress,
				inAmountMessage
			} = pay;

			let etherString = '';
			let isNotEnoughBalance;

			const outCryptoBalance = await exchangerUtils[outCurrency].getBalance();
			if (!outCryptoBalance) {
				log.warn(`Unable to update balance for ${outCurrency} in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
				return;
			}
			
			if (exchangerUtils.isERC20(outCurrency)) {
				const ethBalance = await exchangerUtils['ETH'].getBalance();
				if (!ethBalance) {
					log.warn(`Unable to update balance for ETH in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
					return;
				}
				etherString = `Ether balance: ${exchangerUtils['ETH'].balance}. `;
				isNotEnoughBalance = (outAmount > exchangerUtils[outCurrency].balance) || (exchangerUtils[outCurrency].FEE > exchangerUtils['ETH'].balance);
			} else {
				etherString = '';				
				isNotEnoughBalance = outAmount + exchangerUtils[outCurrency].FEE > exchangerUtils[outCurrency].balance;
			}

			if (isNotEnoughBalance) {
				log.warn('needToSendBack, not enough balance for exchange', outCurrency, outAmount, exchangerUtils[outCurrency].balance);
				pay.update({
					error: 15,
					needToSendBack: true
				}, true);
				notify(`${config.notifyName} notifies about insufficient balance to exchange _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Will try to send payment back. Balance of _${outCurrency}_ is _${exchangerUtils[outCurrency].balance}_. ${etherString}Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`, 'warn');
				api.sendMessage(config.passPhrase, pay.senderId, `I can’t transfer _${outAmount}_ _${outCurrency}_ to you because of insufficient funds (I count blockchain fees also). Check my balances with **/balances** command. I will try to send transfer back to you.`);
				return;
			}

			log.info(`Attempt number ${pay.counterSendExchange} to send exchange payment. Coin: ${outCurrency}, address: ${senderKvsOutAddress}, value: ${outAmount}, balance: ${exchangerUtils[outCurrency].balance}`);
			const result = await exchangerUtils[outCurrency].send({
				address: senderKvsOutAddress,
				value: outAmount,
				comment: 'Done! Thank you for business. Hope to see you again.' // if ADM
			});
			log.info(`Exchange payment result: ${JSON.stringify(result, 0, 2)}`);

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
				log.info(`Successful exchange payment of ${outAmount} ${outCurrency}. Hash: ${result.hash}.`);
			} else { // Can't make a transaction
				if (pay.counterSendExchange++ < 50) { // If number of attempts less then 50, just ignore and try again on next tick
					pay.save();
					return;
				};
				pay.update({
					error: 16,
					needToSendBack: true,
				}, true);
				log.error(`Failed to make exchange payment of ${outAmount} ${outCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`);
				notify(`${config.notifyName} cannot make transaction to exchange _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Will try to send payment back. Balance of _${outCurrency}_ is _${exchangerUtils[outCurrency].balance}_. ${etherString}Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`, 'error');
				api.sendMessage(config.passPhrase, pay.senderId, `I’ve tried to make transfer of _${outAmount}_ _${outCurrency}_ to you, but something went wrong. I will try to send payment back to you.`);
			}
		});
};

setInterval(() => {
	module.exports();
}, 10 * 1000);
