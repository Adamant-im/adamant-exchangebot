
const db = require('./DB');
const { SAT } = require('../helpers/const');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const utils = require('../helpers/utils');
const notify = require('../helpers/notify');
const log = require('../helpers/log');
const config = require('./configReader');
const constants = require('../helpers/const');
const Store = require('./Store');
const api = require('./api');

module.exports = async (itx, tx) => {

	const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${tx ? tx.id : 'undefined'} from ${tx ? tx.senderId : 'undefined'}`;
	try {

		const { paymentsDb } = db;
		const msg = itx.decryptedMessage;
		let inCurrency,
			outCurrency,
			inTxid,
			inAmountMessage;

		if (tx.amount > 0) { // ADM income payment
			inAmountMessage = tx.amount / SAT;
			inCurrency = 'ADM';
			outCurrency = msg;
			inTxid = tx.id;
		} else if (msg.includes('_transaction')) { // not ADM income payment
			inCurrency = msg.match(/"type":"(.*)_transaction/)[1];
			try {
				const json = JSON.parse(msg);
				inAmountMessage = Number(json.amount);
				inTxid = json.hash;
				outCurrency = json.comments;
				if (outCurrency === '') {
					outCurrency = 'NONE';
				}
			} catch (e) {
				inCurrency = 'none';
			}
		}

		outCurrency = String(outCurrency).toUpperCase().trim();
		inCurrency = String(inCurrency).toUpperCase().trim();

		const pay = new paymentsDb({
			_id: tx.id,
			date: utils.unix(),
			admTxId: tx.id,
			itxId: itx._id,
			senderId: tx.senderId,
			inCurrency,
			outCurrency,
			inTxid,
			inAmountMessage: +(inAmountMessage).toFixed(constants.PRECISION_DECIMALS),
			transactionIsValid: null,
			needHumanCheck: false,
			needToSendBack: false,
			transactionIsFailed: false,
			isFinished: false
		});

		// Validate
		let msgSendBack = false;
		let msgNotify = false;
		let notifyType = 'info';
		const min_value_usd = config['min_value_usd_' + inCurrency];
		const min_confirmations = config['min_confirmations_' + inCurrency];
		const inTxidDublicate = await paymentsDb.findOne({ inTxid });
		const sendBackMessage = `I’ll send transfer back to you after I validate it and have _${min_confirmations}_ block confirmations. It can take a time, please be patient.`;

		log.log(`Checking an exchange of ${inAmountMessage} ${inCurrency} for ${outCurrency}… ${admTxDescription}.`);

		// Checkers
		if (inTxidDublicate) {
			pay.isFinished = true;
			pay.error = 1;
			notifyType = 'error';
			msgNotify = `${config.notifyName} thinks transaction of _${inAmountMessage}_ _${inCurrency}_ is duplicated. Tx hash: _${inTxid}_. Will ignore this transaction. ${admTxDescription}.`;
			msgSendBack = `I think transaction of _${inAmountMessage}_ _${inCurrency}_ with Tx ID _${inTxid}_ is duplicated, it will not be processed. If you think it’s a mistake, contact my master.`;
		}
		else if (!exchangerUtils.isKnown(inCurrency)) {
			pay.error = 2;
			pay.needHumanCheck = true;
			pay.isFinished = true;
			notifyType = 'error';
			msgNotify = `${config.notifyName} notifies about incoming transfer of unknown crypto: _${inAmountMessage}_ _${inCurrency}_. **Attention needed**. ${admTxDescription}.`;
			msgSendBack = `I don’t know crypto _${inCurrency}_. I’ve notified my master to send the payment back to you.`;
		}
		else if (!exchangerUtils.isKnown(outCurrency)) {
			pay.error = 3;
			pay.needToSendBack = true;
			notifyType = 'warn';
			msgNotify = `${config.notifyName} notifies about request of unknown crypto: _${outCurrency}_. Will try to send payment of _${inAmountMessage}_ _${inCurrency}_ back. ${admTxDescription}.`;
			msgSendBack = `I don’t work with crypto _${outCurrency}_. ${sendBackMessage}`;
		}
		else if (inCurrency === outCurrency) {
			pay.error = 4;
			pay.needToSendBack = true;
			notifyType = 'warn';
			msgNotify = `${config.notifyName} received request to exchange _${inCurrency}_ for _${outCurrency}_. Will try to send payment back. ${admTxDescription}.`;
			msgSendBack = `Not a big deal to exchange _${inCurrency}_ for _${outCurrency}_, but I think you’ve made a request by mistake. ${sendBackMessage}`;
		}
		else if (!exchangerUtils.isAccepted(inCurrency)) {
			pay.error = 5;
			pay.needToSendBack = true;
			notifyType = 'warn';
			msgNotify = `${config.notifyName} notifies about incoming transfer of unaccepted crypto: _${inAmountMessage}_ _${inCurrency}_. Will try to send payment back. ${admTxDescription}.`;
			msgSendBack = `I don’t accept _${inCurrency}_. ${sendBackMessage}`;
		}
		else if (!exchangerUtils.isExchanged(outCurrency)) {
			pay.error = 6;
			pay.needToSendBack = true;
			notifyType = 'warn';
			msgNotify = `${config.notifyName} notifies about incoming transfer of unaccepted crypto: _${outCurrency}_. Will try to send payment of _${inAmountMessage}_ _${inCurrency}_ back. ${admTxDescription}.`;
			msgSendBack = `I don’t accept exchange to _${outCurrency}_. ${sendBackMessage}`;
		}
		else if (!exchangerUtils.hasTicker(inCurrency)) {
			if (exchangerUtils.isERC20(inCurrency)) { // Unable to send back, as we can't calc fee in ETH
				pay.error = 32;
				pay.needHumanCheck = true;
				pay.isFinished = true;
				notifyType = 'error';
				msgNotify = `${config.notifyName} notifies about unknown rates of crypto _${inCurrency}_. Incoming transfer: _${inAmountMessage}_ _${inCurrency}_. **Attention needed**. ${admTxDescription}.`;
				msgSendBack = `I don’t have rates of crypto _${inCurrency}_ and unable to send payment back. I’ve notified my master to send the payment back to you.`;
			} else { // We can send payment back
				pay.error = 32;
				pay.needToSendBack = true;
				notifyType = 'warn';
				msgNotify = `${config.notifyName} notifies about unknown rates of crypto _${inCurrency}_. Will try to send payment of _${inAmountMessage}_ _${inCurrency}_ back. ${admTxDescription}.`;
				msgSendBack = `I don’t have rates of crypto _${inCurrency}_. ${sendBackMessage}`;
			}
		}
		else if (!exchangerUtils.hasTicker(outCurrency)) {
			pay.error = 33;
			pay.needToSendBack = true;
			notifyType = 'warn';
			msgNotify = `${config.notifyName} notifies about unknown rates of crypto _${outCurrency}_. Will try to send payment of _${inAmountMessage}_ _${inCurrency}_ back. ${admTxDescription}.`;
			msgSendBack = `I don’t have rates of crypto _${outCurrency}_. ${sendBackMessage}`;
		} else {

			// Calculating exchange amount in USD and comparing it to user's daily limit
			pay.inAmountMessageUsd = Store.convertCryptos(inCurrency, 'USD', inAmountMessage).outAmount;
			const userDailyValue = await exchangerUtils.userDailyValue(tx.senderId);
			log.info(`User's ${tx.senderId} daily volume is ${userDailyValue} USD.`);
			if (userDailyValue + pay.inAmountMessageUsd >= config.daily_limit_usd) {
				pay.update({
					error: 23,
					needToSendBack: true
				});
				notifyType = 'warn';
				msgNotify = `${config.notifyName} notifies that user _${tx.senderId}_ exceeds daily limit of _${config.daily_limit_usd}_ USD with transfer of _${inAmountMessage} ${inCurrency}_. Will try to send payment back. ${admTxDescription}.`;
				msgSendBack = `You have exceeded maximum daily volume of _${config.daily_limit_usd}_ USD. ${sendBackMessage}`;
			} else if (!utils.isPositiveOrZeroNumber(pay.inAmountMessageUsd) || pay.inAmountMessageUsd < min_value_usd) {
				pay.update({
					error: 20,
					needToSendBack: true
				});
				notifyType = 'warn';
				msgNotify = `${config.notifyName} notifies about incoming transaction below minimum value of _${min_value_usd}_ USD: _${inAmountMessage}_ _${inCurrency}_ ~ _${pay.inAmountMessageUsd}_ USD. Will try to send payment back. ${admTxDescription}.`;
				msgSendBack = `Exchange value equals _${pay.inAmountMessageUsd}_ USD. I don’t accept exchange crypto below minimum value of _${min_value_usd}_ USD. ${sendBackMessage}`;
			}

		}

		// We've passed all of basic checks
		if (!pay.isFinished && !pay.needToSendBack) {
			pay.update(Store.convertCryptos(inCurrency, outCurrency, inAmountMessage, true));
			if (!pay.outAmount) { // Error while calculating outAmount
				pay.update({
					needToSendBack: true,
					error: 7
				});
				notifyType = 'warn';
				msgNotify = `${config.notifyName} unable to calculate _${outCurrency}_ value to exchange from _${inAmountMessage}_ _${inCurrency}_. Will try to send payment back. ${admTxDescription}.`;
				msgSendBack = `I can't calculate _${outCurrency}_ amount to exchange from _${inAmountMessage}_ _${inCurrency}_. ${sendBackMessage}`;
			} else { // Transaction is fine
				notifyType = 'log';
				msgNotify = `${config.notifyName} notifies about incoming transaction to exchange _${inAmountMessage}_ _${inCurrency}_ for *${pay.outAmount}* *${outCurrency}* at _${pay.exchangePrice}_ _${outCurrency}_ / _${inCurrency}_. Tx hash: _${inTxid}_. ${admTxDescription}.`;
				msgSendBack = `I understood your request to exchange _${inAmountMessage}_ _${inCurrency}_ for **${pay.outAmount}** **${outCurrency}** at _${pay.exchangePrice}_ _${outCurrency}_ / _${inCurrency}_. Now I will validate your transfer and wait for _${min_confirmations}_ block confirmations. It can take a time, please be patient.`;
			}
		}

		await pay.save();
		await itx.update({ isProcessed: true }, true);

		notify(msgNotify, notifyType);
		api.sendMessage(config.passPhrase, tx.senderId, msgSendBack).then(response => {
			if (!response.success)
				log.warn(`Failed to send ADM message '${msgSendBack}' to ${tx.senderId}. ${response.errorMessage}.`);
		});

	} catch (e) {
		notify(`Error while processing exchange Tx ${tx ? tx.id : 'undefined'} from ${tx ? tx.senderId : 'undefined'} in ${utils.getModuleName(module.id)} module. You may need to process it manually, see logs. Error: ` + e, 'error');
	}

};
