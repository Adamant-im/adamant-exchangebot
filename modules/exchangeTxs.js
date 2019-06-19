
const db = require('./DB');
const {SAT} = require('../helpers/const');
const $u = require('../helpers/utils');
const notify = require('../helpers/notify');
const api = require('./api');
const config = require('./configReader');
const Store = require('./Store');
const deepExchangeValidator = require('./deepExchangeValidator');

module.exports = async (itx, tx) => {
	const {paymentsDb} = db;
	const {min_confirmations} = config;
	const msg = itx.encrypted_content;
	let inCurrency,
		outCurrency,
		inTxid,
		inAmountMessage;

	if (tx.amount > 0){ // ADM income payment
		inAmountMessage = tx.amount / SAT;
		inCurrency = 'ADM';
		outCurrency = msg;
		inTxid = tx.id;
	} else if (msg.includes('_transaction')){ // not ADM income payment
		inCurrency = msg.match(/"type":"(.*)_transaction/)[1];
		try {
			const json = JSON.parse(msg);
			inAmountMessage = Number(json.amount);
			inTxid = json.hash;
			outCurrency = json.comments;
		} catch (e){
			inCurrency = 'none';
		}
	}

	if (typeof outCurrency === 'string'){
		outCurrency = outCurrency.toUpperCase().trim();
	}
	const pay = new paymentsDb({
		date: $u.unix(),
		itxId: itx._id,
		senderId: tx.senderId,
		inCurrency,
		outCurrency,
		inTxid,
		tryCounter: 0,
		inAmountMessage: +(inAmountMessage).toFixed(8),
		transactionIsValid: null,
		need
		Check: false,
		needToSendBack: false,
		transactionIsFailed: false,
		isFinished: false
	});
	
	// Validate
	let msgSendBack = false;
	let msgNotify = false;
	const inTxidDublicate = await paymentsDb.findOne({inTxid});

	// Checkers
	if (inTxidDublicate){
		pay.isFinished = true;
		pay.error = 1;
		msgNotify = `Exchange Bot ${Store.user.ADM.address} thinks transaction of _${inAmountMessage}_ _${inCurrency}_ is duplicated. Tx hash: _${inTxid}_. Income ADAMANT Tx: _https://oldexplorer.adamant.im/tx/${tx.id}_.`;
		msgSendBack = `I think transaction of _${inAmountMessage}_ _${inCurrency}_ with Tx ID _${inTxid}_ is duplicated, it will not be processed. If you think it’s a mistake, contact my master.`;
	}
	else if (!config.known_crypto.includes(inCurrency)){
		pay.error = 2;
		pay.needHumanCheck = true;
		pay.isFinished = true;
		msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about incoming transfer of unknown crypto: _${inCurrency}_. Income ADAMANT Tx: _https://oldexplorer.adamant.im/tx/${tx.id}_.`;
		msgSendBack = 'I don’t know crypto _${inCurrency}_. If you think it’s a mistake, contact my master.';
	}
	else if (!config.known_crypto.includes(outCurrency)){
		pay.error = 3;
		pay.needToSendBack = true;
		msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about request of unknown crypto: _${outCurrency}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${tx.id}_.`;
		msgSendBack = `I don’t know crypto _${outCurrency}_. I will try to send transfer back to you. I will validate your transfer and wait for _${min_confirmations}_ block confirmations. It can take a time, please be patient.`;
	}
	else if (inCurrency === outCurrency){
		pay.error = 4;
		pay.needToSendBack = true;
		msgNotify = `Exchange Bot ${Store.user.ADM.address} received request to exchange _${inCurrency}_ for _${outCurrency}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${tx.id}_.`;
		msgSendBack = `Not a big deal to exchange _${inCurrency}_ for _${outCurrency}_. But I think you made a request by mistake. Better I will try to send transfer back to you. I will validate your transfer and wait for _${min_confirmations}_ block confirmations. It can take a time, please be patient.`;
	}
	else if (!config.accepted_crypto.includes(inCurrency)){
		pay.error = 5;
		pay.needToSendBack = true;
		msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about incoming transfer of unaccepted crypto: _${inCurrency}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${tx.id}_.`;
		msgSendBack = `Crypto _${inCurrency}_ is not accepted. I will try to send transfer back to you. I will validate your transfer and wait for _${min_confirmations}_ block confirmations. It can take a time, please be patient.`;
	}
	else if (!config.exchange_crypto.includes(outCurrency)){
		pay.error = 6;
		pay.needToSendBack = true;
		msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about incoming transfer of unaccepted crypto: _${outCurrency}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${tx.id}_.`;
		msgSendBack = `I don’t accept exchange to _${outCurrency}_. I will try to send transfer back to you. I will validate your transfer and wait for _${min_confirmations}_ block confirmations. It can take a time, please be patient.`;
	}
	
	// TODO: equal USD
	// TODO: Daily_limit_usd
	
	let notifyType = 'info';
	if (pay.isFinished){
		notifyType = 'error';
	} else if (pay.needToSendBack){ // Error validate
		notifyType = 'warn';
	} else {
		pay.update(Store.mathEqual(inCurrency, outCurrency, inAmountMessage));
		if (!pay.outAmount){ // Error while calculating outAmount
			pay.error = 7;
			pay.needToSendBack = true;
			msgNotify = `Exchange Bot ${Store.user.ADM.address} unable to calculate _outAmount_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${tx.id}_.`;
			msgSendBack = `I can't calculate _${outCurrency}_ amount to exchange _${inAmountMessage}_ _${inCurrency}_. I will try to send transfer back to you. I will validate your transfer and wait for _${min_confirmations}_ block confirmations. It can take a time, please be patient.`;
		} else { // Transaction is fine
			msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about incoming transaction to exchange _${inAmountMessage}_ _${inCurrency}_ for *${pay.outAmount}* *${outCurrency}* at _${pay.exchangePrice}_ _${outCurrency}_ / _${inCurrency}_. Tx hash: _${inTxid}_. Income ADAMANT Tx: _https://explorer.adamant.im/tx/${tx.id}_.`;
			msgSendBack = `I understood your request to exchange _${inAmountMessage}_ _${inCurrency}_ for *${pay.outAmount}* *${outCurrency}* at _${pay.exchangePrice}_ _${outCurrency}_ / _${inCurrency}_. Now I will validate your transfer and wait for _${min_confirmations}_ block confirmations. It can take a time, please be patient.`;
		}
	}

	await pay.save();
	await itx.update({isProcessed: true}, true);

	notify(msgNotify, notifyType);
	$u.sendAdmMsg(tx.senderId, msgSendBack);

	if (!pay.isFinished){
		deepExchangeValidator(pay, tx);
	}
};


