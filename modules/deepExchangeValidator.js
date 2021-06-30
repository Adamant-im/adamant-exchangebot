const log = require('../helpers/log');
const notify = require('../helpers/notify');
const config = require('./configReader');
const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const db = require('./DB');
const api = require('./api');
const confirmationsCounter = require('./confirmationsCounter');

module.exports = async (pay, tx) => {

	const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${tx.id} from ${tx.senderId}`;
	try {

		log.log(`Validating Tx ${pay.inTxid}… ${admTxDescription}.`)

		pay.counterTxDeepValidator = ++pay.counterTxDeepValidator || 0;

		// Fetching addresses from ADAMANT KVS
		let senderKvsInAddress = pay.senderKvsInAddress || pay.inCurrency === 'ADM' && tx.senderId ||
			await exchangerUtils.getKvsCryptoAddress(pay.inCurrency, tx.senderId);
		let senderKvsOutAddress = pay.senderKvsOutAddress || pay.outCurrency === 'ADM' && tx.senderId ||
			await exchangerUtils.getKvsCryptoAddress(pay.outCurrency, tx.senderId);

		pay.update({
			senderKvsInAddress,
			senderKvsOutAddress
		});

		if (!senderKvsInAddress) {
			log.warn(`Unable to fetch ${pay.inCurrency} address for ${tx.senderId} from KVS. Will try next time. ${admTxDescription}.`);
			pay.save();
			return;
		}

		if (!senderKvsOutAddress && !pay.needToSendBack) {
			log.warn(`Unable to fetch ${pay.outCurrency} address for ${tx.senderId} from KVS. Will try next time. ${admTxDescription}.`);
			pay.save();
			return;
		}

		let notifyType = 'log';
		if (senderKvsInAddress === 'none') {
			pay.update({
				error: constants.ERRORS.NO_IN_KVS_ADDRESS,
				isFinished: true,
				needHumanCheck: true
			}, true);
			notifyType = 'error';
			notify(`${config.notifyName} cannot fetch address from KVS for crypto: _${pay.inCurrency}_. Attention needed. ${admTxDescription}.`, 'error');
			api.sendMessage(config.passPhrase, tx.senderId, `I can’t get your _${pay.inCurrency}_ address from ADAMANT KVS. If you think it’s a mistake, contact my master.`);
			return;
		};

		let msgSendBack = false;
		let msgNotify = false;
		if (senderKvsOutAddress === 'none' && !pay.needToSendBack) {
			pay.update({
				needToSendBack: true,
				error: constants.ERRORS.NO_OUT_KVS_ADDRESS
			});
			notifyType = 'warn';
			msgNotify = `${config.notifyName} cannot fetch address from KVS for crypto: _${pay.outCurrency}_. Will try to send payment back.`;
			msgSendBack = `I can’t get your _${pay.outCurrency}_ address from ADAMANT KVS. Make sure you use ADAMANT wallet with _${pay.outCurrency}_ enabled. Now I will try to send transfer back to you. I will validate your transfer and wait for _${config['min_confirmations_' + pay.inCurrency]}_ block confirmations. It can take a time, please be patient.`;
		}

		// Validating incoming TX in blockchain of inCurrency

		const incomeTx = await exchangerUtils[pay.inCurrency].getTransaction(pay.inTxid);
		if (!incomeTx) {
			if (pay.counterTxDeepValidator < constants.VALIDATOR_GET_TX_RETRIES) {
				pay.save();
				log.warn(`Unable to get Tx ${pay.inTxid}. It's expected, if the Tx is new. Will try again next time. ${admTxDescription}.`)
				return;
			}
			pay.update({
				transactionIsValid: false,
				isFinished: true,
				error: constants.ERRORS.UNABLE_TO_FETCH_TX
			});
			notifyType = 'warn';
			msgNotify = `${config.notifyName} can’t fetch transaction of _${pay.inAmountMessage} ${pay.inCurrency}_.`;
			msgSendBack = `I can’t get transaction of _${pay.in_amount_message} ${pay.inCurrency}_ with Tx ID _${pay.inTxid}_ from _ ${pay.inCurrency}_ blockchain. It might be failed or cancelled. If you think it’s a mistake, contact my master.`;
		} else { // We got incomeTx details

			pay.update({
				senderId: incomeTx.senderId,
				recipientId: incomeTx.recipientId,
				inAmountReal: incomeTx.amount,
				inTxFee: incomeTx.fee,
				inTxStatus: incomeTx.status,
				inTxHeight: incomeTx.height,
				inTxTimestamp: incomeTx.timestamp,
				inConfirmations: incomeTx.confirmations
			});

			if (!pay.senderId || !pay.recipientId || !pay.inAmountReal || !pay.inTxTimestamp) {
				pay.save();
				log.warn(`Unable to get full details of transaction: senderId ${pay.senderId}, recipientId ${pay.recipientId}, inAmountReal ${pay.inAmountReal}, inTxTimestamp ${pay.inTxTimestamp}. Will try again next time. Tx hash: ${pay.inTxid}. ${admTxDescription}.`)
				return;
			}

			if (!utils.isStringEqualCI(pay.senderId, pay.senderKvsInAddress)) {
				pay.update({
					transactionIsValid: false,
					isFinished: true,
					error: constants.ERRORS.WRONG_SENDER
				});
				notifyType = 'error';
				msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Sender expected: _${senderKvsInAddress}_, but real sender is _${pay.senderId}_.`;
				msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
			} else if (!utils.isStringEqualCI(pay.recipientId, exchangerUtils[pay.inCurrency].account.address)) {
				pay.update({
					transactionIsValid: false,
					isFinished: true,
					error: constants.ERRORS.WRONG_RECIPIENT
				});
				notifyType = 'error';
				msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Recipient expected: _${exchangerUtils[pay.inCurrency].account.address}_, but real recipient is _${pay.recipientId}_.`;
				msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
			} else if (Math.abs(pay.inAmountReal - pay.inAmountMessage) > pay.inAmountReal * constants.VALIDATOR_AMOUNT_DEVIATION) {
				pay.update({
					transactionIsValid: false,
					isFinished: true,
					error: constants.ERRORS.WRONG_AMOUNT
				});
				notifyType = 'error';
				msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Amount expected: _${pay.inAmountMessage}_, but real amount is _${pay.inAmountReal}_.`;
				msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
			} else if (Math.abs(utils.toTimestamp(tx.timestamp) - pay.inAmountMessage) > constants.VALIDATOR_TIMESTAMP_DEVIATION) {
				pay.update({
					transactionIsValid: false,
					isFinished: true,
					error: constants.ERRORS.WRONG_TIMESTAMP
				});
				notifyType = 'error';
				msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Tx's timestamp is _${(Math.abs(utils.toTimestamp(tx.timestamp) - pay.inAmountMessage) / constants.HOUR).toFixed(0)}_ hours late.`;
				msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
			} else { // Transaction is valid
				pay.update({
					transactionIsValid: true
				});
			}
		} // We got incomeTx details

		await pay.save();
		if (pay.transactionIsValid) {
			confirmationsCounter(pay);
		}

		if (msgSendBack) {
			notify(msgNotify + ` Tx hash: _${pay.inTxid}_. ${admTxDescription}.`, notifyType);
			api.sendMessage(config.passPhrase, tx.senderId, msgSendBack);
		}

	} catch (e) {
		log.error(`Failed to validate Tx ${pay.inTxid}: ${e.toString()}. Will try again next time. ${admTxDescription}.`)
	}
};

setInterval(async () => {
	const { paymentsDb } = db;
	(await paymentsDb.find({
		transactionIsValid: null,
		isFinished: false
	})).forEach(async pay => {
		const tx = await api.get('transactions/get', { id: pay.admTxId });
		if (tx.success) {
			module.exports(pay, tx.data.transaction);
		} else {
			log.warn(`Unable to fetch Tx ${pay.admTxId} in setInterval() of ${utils.getModuleName(module.id)} module. ${tx.errorMessage}.`);
		}
	});
}, constants.VALIDATOR_TX_INTERVAL);
