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
			if (!['ADM'].includes(inCurrency)) {  // If inCurrency blockchain needs for checkeng current block number
				if (!lastBlockNumber[inCurrency]){
					log.warn('Cannot get lastBlockNumber for ' + inCurrency + '. Waiting for next try.');
					return;
				}
				const {status, blockNumber} = (await $u[inCurrency].getTransactionStatus(inTxid));
				if (!blockNumber){
					console.log('Cannot get status or current blockNumber for ' + inCurrency + '. Waiting for next try.', {blockNumber, status});
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
					msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is Failed. Tx hash: _${inTxid}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/<in_adm_txid>_.`;
					msgSendBack = `Transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${inTxid}_ is Failed and will not be processed. Check _${pay.inCurrency}_ blockchain explorer and try again. If you think it’s a mistake, contact my master.`;
				}
			} else { // Simple check if inCurrency crypto API allows to get confirmations count
				const tx = await api.get('uri', 'transactions/get?id=' + inTxid);
				if (!tx.success) {
					return;
				}
				pay.inTxStatus = true;
				pay.inConfirmations = tx.transaction.confirmations;
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
