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
	})).filter(p => p.inConfirmations >= config.min_confirmations)
		.forEach(async pay => {
			const {
				outAmount,
				inCurrency,
				outCurrency,
				senderKvsOutAddress,
				inAmountMessage
			} = pay;
			
			pay.tryCounter++;
			if (outAmount > Store.user[outCurrency].balance) {
				log.warn('needToSendBack, not enough ' + outCurrency + ' balance for exchange', outCurrency, outAmount, Store.user[outCurrency].balance);
				pay.update({
					error: 15,
					needToSendBack: true
				}, true);
				notify(`Exchange Bot ${Store.user.ADM.address} notifies about insufficient balance for exchange of ${inAmountMessage} ${inCurrency} for ${outAmount} ${outCurrency}. Balance of ${outCurrency} is ${Store.user[outCurrency].balance}. <ether_string>Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}.`, 'warn');
				$u.sendAdmMsg(pay.senderId, `I can’t transfer ${outAmount} ${outCurrency} to you because of insufficient funds (I count blockchain fees also). Check my balances with /balances command. I will try to send transfer back to you.`);
				return;
			}
			console.log('Send', {
				outCurrency,
				address: senderKvsOutAddress,
				value: outAmount,
				balance: Store.user[outCurrency].balance
			});
			const result = await $u[outCurrency].send({
				address: senderKvsOutAddress,
				value: outAmount // TODO: add fee exchange
			});
			console.log({
				result
			});
			if (result.success) {
				pay.update({
					outTxid: result.hash
				}, true);
				Store.user[outCurrency].balance -= outAmount;
				log.info(`Success exchange send ${outAmount} ${outCurrency}. Hash: ${result.hash}`);
			} else { // TODO: send again 50 times!!!!???
				pay.update({
					error: 16,
					needHumanCheck: true,
					isFinished: true
				}, true);
				log.error(`Fail exchange send ${outAmount} ${outCurrency}`);
			}
		});
};

setInterval(() => {
	module.exports();
}, 10 * 1000);
