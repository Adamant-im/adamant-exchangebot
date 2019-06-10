const db = require('./DB');
const config = require('./configReader');
const $u = require('../helpers/utils');
const api = require('./api');
const Store = require('./Store');
const log = require('../helpers/log');
const notify = require('../helpers/notify');

module.exports = async () => {
	const {paymentsDb} = db;

	const lastBlockNumber = {
		ETH: await $u.ETH.getLastBlockNumber()
	};
	if (!lastBlockNumber.ETH){
		return;
	}

	(await paymentsDb.find({
		transactionIsValid: true,
		isFinished: false,
		transactionIsFailed: false
	})).forEach(async pay => {
		try {
			let msgNotify = null;
			let msgSendBack = null;

			const {
				inConfirmations,
				inCurrency,
				inTxid,
				inTxStatus
			} = pay;

			if (inTxStatus && inConfirmations >= config.min_confirmations){
				return;
			}
			if (inCurrency !== 'ADM') {
				const {status, blockNumber} = (await $u[inCurrency].getTransactionStatus(inTxid));
				if (!blockNumber){
					console.log('Return', {blockNumber, status});
					return;
				}

				pay.update({
					inTxStatus: status,
					inConfirmations: lastBlockNumber[inCurrency] - blockNumber
				});
				if (status === false){
					pay.update({
						error: 14,
						transactionIsFailed: true,
						isFinished: true
					});
					msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies transaction of ${pay.inAmountMessage} ${pay.inCurrency} is Failed. Tx hash: ${inTxid}. Income ADAMANT Tx: https://explorer.adamant.im/tx/<in_adm_txid>`;
					msgSendBack = `Transaction of ${pay.inAmountMessage} ${pay.inCurrency} with Tx ID ${inTxid} is Failed and will not be processed. Try again. If you think it’s a mistake, contact my master.`;
				}
			} else { // if ADM
				const tx = await api.get('uri', 'transactions/get?id=' + inTxid);
				if (!tx.success) {
					return;
				}
				pay.inConfirmations = tx.transaction.confirmations;
			}
			// console.log(`
			// inCurrency: ${inCurrency}
			// inConfirmations: ${pay.inConfirmations}
			// status:			${pay.inTxStatus}`);
			await pay.save();
			if (msgSendBack) {
				notify(msgNotify, 'warn');
				$u.sendAdmMsg(pay.senderId, msgSendBack);
			}
		} catch (e) {
			log.error(' conformations counter ' + e);
		}
	});

};
setInterval(() => {
	module.exports();
}, 10 * 1000);
