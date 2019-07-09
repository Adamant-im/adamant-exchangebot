const db = require('./DB');
const config = require('./configReader');
const $u = require('../helpers/utils');
const Store = require('./Store');
const log = require('../helpers/log');
const notify = require('../helpers/notify');

module.exports = async () => {
	const {paymentsDb} = db;
	await $u.updateAllBalances();

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
			if (outAmount + $u[outCurrency].FEE > Store.user[outCurrency].balance) {
				log.warn('needToSendBack, not enough ' + outCurrency + ' balance for exchange', outCurrency, outAmount, Store.user[outCurrency].balance);
				pay.update({
					error: 15,
					needToSendBack: true
				}, true);
				notify(`Exchange Bot ${Store.botName} notifies about insufficient balance to exchange _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Will try to send payment back. Balance of _${outCurrency}_ is _${Store.user[outCurrency].balance}_. ${etherString}Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`, 'warn');
				$u.sendAdmMsg(pay.senderId, `I can’t transfer _${outAmount}_ _${outCurrency}_ to you because of insufficient funds (I count blockchain fees also). Check my balances with **/balances** command. I will try to send transfer back to you.`);
				return;
			}

			log.info(`Attempt to send exchange payment:
				Coin: ${outCurrency},
				address:${senderKvsOutAddress},
				value: ${outAmount},
				balance: ${Store.user[outCurrency].balance}
			`);
			const result = await $u[outCurrency].send({
				address: senderKvsOutAddress,
				value: outAmount,
				comment: 'Done! Thank you for business. Hope to see you again.' // if ADM
			});
			log.info(`Exchange payment result:
			${JSON.stringify(result, 0, 2)}`);

			if (result.success) {
				pay.update({
					outTxid: result.hash
				}, true);
				Store.user[outCurrency].balance -= (outAmount + $u[outCurrency].FEE);
				log.info(`Successful exchange payment of ${outAmount} ${outCurrency}. Hash: ${result.hash}.`);
			} else { // Can't make a transaction

				if (pay.counterSendExchange++ < 50){
					pay.save();
					return;
				};
				pay.update({
					error: 16,
					needToSendBack: true,
				}, true);
				log.error(`Failed to make exchange payment of ${outAmount} ${outCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`);
				notify(`Exchange Bot ${Store.botName} cannot make transaction to exchange _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Will try to send payment back. Balance of _${outCurrency}_ is _${Store.user[outCurrency].balance}_. ${etherString}Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`, 'error');
				$u.sendAdmMsg(pay.senderId, `I’ve tried to make transfer of _${outAmount}_ _${outCurrency}_ to you, but something went wrong. I will try to send payment back to you.`);
			}
		});
};

setInterval(() => {
	module.exports();
}, 10 * 1000);
