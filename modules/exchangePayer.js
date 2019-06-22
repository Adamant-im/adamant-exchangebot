const db = require('./DB');
const config = require('./configReader');
const $u = require('../helpers/utils');
const api = require('./api');
const Store = require('./Store');
const log = require('../helpers/log');
const notify = require('../helpers/notify');

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
			const {
				outAmount,
				inCurrency,
				outCurrency,
				senderKvsOutAddress,
				inAmountMessage
			} = pay;
			
			pay.tryCounter++;
			let etherString = '';
			if (outAmount > Store.user[outCurrency].balance) {
				log.warn('needToSendBack, not enough ' + outCurrency + ' balance for exchange', outCurrency, outAmount, Store.user[outCurrency].balance);
				pay.update({
					error: 15,
					needToSendBack: true
				}, true);
				notify(`Exchange Bot ${Store.user.ADM.address} notifies about insufficient balance to exchange _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Balance of _${outCurrency}_ is _${Store.user[outCurrency].balance}_. ${etherString}Income ADAMANT Tx: _https://explorer.adamant.im/tx/${pay.itxId}_.`, 'warn');
				$u.sendAdmMsg(pay.senderId, `I can’t transfer _${outAmount}_ _${outCurrency}_ to you because of insufficient funds (I count blockchain fees also). Check my balances with */balances* command. I will try to send transfer back to you.`);
				return;
			}
		
			console.log('Attempt to send exchange payment', {
				outCurrency,
				address: senderKvsOutAddress,
				value: outAmount,
				balance: Store.user[outCurrency].balance
			});

			const successMsg = `I’ve tried to make transfer of _${outAmount}_ _${outCurrency}_ to you, but something went wrong. I will try to send transfer back to you.`;
			const result = await $u[outCurrency].send({
				address: senderKvsOutAddress,
				value: outAmount, // TODO: add fee exchange
				comment: successMsg
			});
			console.log('Exchange payment result', {
				result
			});
			
			if (result.success) {
				pay.update({
					outTxid: result.hash
				}, true);
				Store.user[outCurrency].balance -= outAmount; // TODO: count fee if needed
				log.info(`Successful exchange payment of ${outAmount} ${outCurrency}. Hash: ${result.hash}.`);
			} else { // Can't make a transaction. TODO: check tryCounter and try again 20 times
				pay.update({
					error: 16,
					needToSendBack: true,
				}, true);
				log.error(`Failed to make exchange payment of ${outAmount} ${outCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`);
				notify(`Exchange Bot ${Store.user.ADM.address} cannot make transaction to exchange _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Balance of _${outCurrency}_ is _${Store.user[outCurrency].balance}_. ${etherString}Income ADAMANT Tx: _https://explorer.adamant.im/tx/${pay.itxId}_.`, 'error');
				if (outCurrency !== 'ADM') {
					$u.sendAdmMsg(pay.senderId, successMsg);
				}
			}
		});
};

setInterval(() => {
	module.exports();
}, 10 * 1000);
