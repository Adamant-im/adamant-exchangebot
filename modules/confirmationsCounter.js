const db = require('./DB');
const config = require('./configReader');
const $u = require('../helpers/utils');
const Store = require('./Store');
const log = require('../helpers/log');
const notify = require('../helpers/notify');

module.exports = async () => {
	const {paymentsDb} = db;

	const lastBlockNumber = {
		ETH: await $u.ETH.getLastBlockNumber(),
		ADM: await $u.ADM.getLastBlockNumber(),
	};

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
				inTxStatus,
				admTxId
			} = pay;

			if (inTxStatus && inConfirmations >= config['min_confirmations_' + inCurrency]){
				return;
			}

			if (!lastBlockNumber[inCurrency]){
				log.warn('Cannot get lastBlockNumber for ' + inCurrency + '. Waiting for next try.');
				return;
			}
			const txData = (await $u[inCurrency].getTransactionStatus(inTxid));
			if (!txData || !txData.blockNumber){
				return;
			}
			const {status, blockNumber} = txData;

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
				msgNotify = `Exchange Bot ${Store.botName} notifies transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is Failed. Tx hash: _${inTxid}_. Income ADAMANT Tx: https://explorer.adamant.im/tx/${admTxId}.`;
				msgSendBack = `Transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${inTxid}_ is Failed and will not be processed. Check _${pay.inCurrency}_ blockchain explorer and try again. If you think it’s a mistake, contact my master.`;
			}

			await pay.save();
			if (msgSendBack) {
				notify(msgNotify, 'error');
				$u.sendAdmMsg(pay.senderId, msgSendBack);
			}
		} catch (e) {
			log.error('Error in ConformationsCounter module: ' + e);
		}
	});

};
setInterval(() => {
	module.exports();
}, 10 * 1000);
