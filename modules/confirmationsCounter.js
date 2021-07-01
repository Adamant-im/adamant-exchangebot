const config = require('./configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const db = require('./DB');
const api = require('./api');

module.exports = async (pay) => {

	const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay.admTxId} from ${pay.senderId}`;
	try {

		let msgNotify = null;
		let msgSendBack = null;

		log.log(`Updating incoming Tx ${pay.inTxid} confirmations… ${admTxDescription}.`)

		const tx = await exchangerUtils[pay.inCurrency].getTransaction(pay.inTxid);
		if (!tx) {
			log.warn(`Unable to fetch validated Tx ${pay.inTxid} info. Will try again next time. ${admTxDescription}.`);
			return;
		}
		if (!tx.height && !tx.confirmations) {
			log.warn(`Unable to get Tx ${pay.inTxid} height and confirmations. Will try again next time. ${admTxDescription}.`);
			return;
		}

		let confirmations = tx.confirmations;
		if (!tx.confirmations) {
			const lastBlockHeight = await exchangerUtils[pay.inCurrency].getLastBlockHeight();
			if (!lastBlockHeight) {
				log.warn(`Unable to get last block height for ${pay.inCurrency} to count Tx ${pay.inTxid} confirmations in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
				return;
			}
			confirmations = lastBlockHeight - tx.height;
		}

		pay.update({
			inTxStatus: tx.status,
			inConfirmations: confirmations
		});

		if (pay.inTxStatus && pay.inConfirmations >= config['min_confirmations_' + pay.inCurrency]) {
			await pay.update({
				inTxConfirmed: true
			}, true);
			log.log(`Tx ${pay.inTxid} is confirmed, it reached minimum of ${config['min_confirmations_' + pay.inCurrency]}. ${admTxDescription}.`);
			return;
		}

		if (pay.status === false) {
			pay.update({
				error: constants.ERRORS.TX_FAILED,
				transactionIsFailed: true,
				isFinished: true
			});
			msgNotify = `${config.notifyName} notifies transaction _${pay.inTxid}_ of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is Failed. ${admTxDescription}.`;
			msgSendBack = `Transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_ is Failed and will not be processed. Check _${pay.inCurrency}_ blockchain explorer and try again. If you think it’s a mistake, contact my master.`;
		}

		await pay.save();
		if (msgSendBack) {
			notify(msgNotify, 'error');
			api.sendMessage(config.passPhrase, pay.senderId, msgSendBack);
		}

	} catch (e) {
		log.error(`Failed to get Tx ${pay.inTxid} confirmations: ${e.toString()}. Will try again next time. ${admTxDescription}.`)
	}

};

setInterval(async () => {
	const { paymentsDb } = db;
	(await paymentsDb.find({
		transactionIsValid: true,
		isFinished: false,
		transactionIsFailed: false,
		inTxConfirmed: {$ne: true}
	})).forEach(async pay => {
			module.exports(pay);
	});
}, constants.CONFIRMATIONS_INTERVAL);
