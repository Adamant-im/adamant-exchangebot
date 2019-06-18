const db = require('./DB');
const config = require('./configReader');
const $u = require('../helpers/utils');
const api = require('./api');
const Store = require('./Store');
const log = require('../helpers/log');
const notify = require('../helpers/notify');

module.exports = async () => {
	const {
		paymentsDb
	} = db;

	(await paymentsDb.find({
		transactionIsValid: true,
		isFinished: false,
		transactionIsFailed: false,
		needToSendBack: true,
		needHumanCheck: false,
		inTxStatus: true,
		sentBackTx: null
	})).filter(p => p.inConfirmations >= config.min_confirmations)
		.forEach(async pay => {
			const {
				inAmountReal,
				inCurrency,
				senderKvsInAddress
			} = pay;

			let msgSendBack = false;
			let msgNotify = false;

			const outFee = $u[inCurrency].FEE;
			const sentBackAmount = inAmountReal - outFee;
			const sentBackAmountUsd = Store.mathEqual(inCurrency, 'USD', sentBackAmount).outAmount;

			if (sentBackAmountUsd < 0 || sentBackAmountUsd < config.min_value_usd){
				pay.errorSendBack = 16;
				msgNotify = '(need text msg!) I can’t send transfer back to you because it does not cover blockchain fees. If you think it’s a mistake, contact my master';
				msgSendBack = 'I can’t send transfer back to you because it does not cover blockchain fees. If you think it’s a mistake, contact my master.';
			} else if (sentBackAmount > Store.user[inCurrency].balance){
				msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about insufficient balance for send back of ${inAmountReal} ${inCurrency}. Balance of <out_currency> is <out_balance>. <ether_string>Income ADAMANT Tx: https://explorer.adamant.im/tx/${pay.itxId}. Attention needed.`;
				msgSendBack = 'I can’t send transfer back to you because of insufficient balance. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.';
				pay.errorSendBack = 17;
				pay.needHumanCheck = true;
			} else {// its Ok, send back!
				const result = await $u[inCurrency].send({
					address: senderKvsInAddress,
					value: sentBackAmount
				});
				if (result.success) {
					pay.sentBackTx = result.hash;
					Store.user[inCurrency].balance -= inAmountReal;
					log.info(`Success back send ${sentBackAmount} ${inCurrency}. Hash: ${result.hash}`);
					msgSendBack = `Success back send ${sentBackAmount} ${inCurrency}. Hash: ${result.hash}`;
				} else { // TODO: send again 50 times!!!!???
					pay.errorSendBack = 18;
					pay.needHumanCheck = true;
					log.error(`Fail exchange send ${sentBackAmount} ${inCurrency}`);
					msgSendBack = 'I can’t send transfer back to you. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.';
				}
			}
			// console.log({
			// 	tx: pay.sentBackTx,
			// 	error: pay.errorSendBack,
			// 	balance: Store.user[inCurrency].balance,
			// 	outFee,
			// 	sentBackAmount,
			// 	sentBackAmountUsd
			// });
			pay.update({
				isFinished: true,
				outFee,
				sentBackAmount,
				sentBackAmountUsd
			}, true);

			notify(msgNotify, 'error');
			$u.sendAdmMsg(pay.senderId, msgSendBack);
		});
};

setInterval(() => {
	module.exports();
}, 17 * 1000);

//    {_id: 5d07e08a26c063255467301a,
//      date: 1560797322624,
//      itxId: 5d07e08826c0632554673013,
//      senderId: 'U15174911558868491228',
//      inCurrency: 'ETH',
//      outCurrency: 'BVB',
//      inTxid:
//       '0x2c55be7573a306ec6060f1261842f382ed6c1678c2c8499e5f327fd242f53f68',
//      tryCounter: 1,
//      inAmountMessage: 0.001,
//      transactionIsValid: true,
//      needHumanCheck: false,
//      needToSendBack: true,
//      transactionIsFailed: false,
//      isFinished: false,
//      error: 3,
//      inAmountReal: 0.001,
//      inConfirmations: 44462,
//      recipient: '0xEFb1d6CA32D33B546Fd9b1C4FC12db44c8B788c6',
//      sender: '0x1c8c51d069B154b13EC5B83e8243e185871A5EAA',
//      senderKvsInAddress: '0x1c8c51d069b154b13ec5b83e8243e185871a5eaa',
//      senderKvsOutAddress: null,
//      inTxStatus: true } }
