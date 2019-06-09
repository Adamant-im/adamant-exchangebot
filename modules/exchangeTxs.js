
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

	if (tx.amount > 0){ // ADM
		inAmountMessage = tx.amount / SAT;
		inCurrency = 'ADM';
		outCurrency = msg;
		inTxid = tx.id;
	} else if (msg.includes('_transaction')){ // no ADM
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
		inAmountMessage,
		transactionIsValid: null,
		needHumanCheck: false,
		needToSendBack: false,
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
		msgNotify = `Exchange Bot ${Store.user.ADM.address} thinks transaction of ${inAmountMessage} ${inCurrency} is duplicated. Tx hash: ${inTxid}. Income ADAMANT Tx: https://explorer.adamant.im/tx/<in_adm_txid>.. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`;

		msgSendBack = `I think transaction of ${inAmountMessage} ${inCurrency} with Tx ID ${inTxid} is duplicated, it will not be processed. If you think it’s a mistake, contact my master.`;
	}
	else if (!config.known_crypto.includes(inCurrency)){
		pay.error = 2;
		pay.needHumanCheck = true;
		pay.isFinished = true;
		msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about incoming transfer of unknown crypto: ${inCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`;

		msgSendBack = 'I don’t know crypto ${inCurrency}. If you think it’s a mistake, contact my master.';
	}
	else if (!config.known_crypto.includes(outCurrency)){
		pay.error = 3;
		pay.needToSendBack = true;

		msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about request of unknown crypto: ${outCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`;

		msgSendBack = `I don’t know crypto ${outCurrency}. I will try to send transfer back to you. I will validate your transfer and wait for ${min_confirmations} block confirmations. It can take a time, please be patient.`;
	}
	else if (inCurrency === outCurrency){
		pay.error = 4;
		pay.needToSendBack = true;

		msgNotify = `Exchange Bot ${Store.user.ADM.address} received request to exchange ${inCurrency} for ${outCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`;

		msgSendBack = `Not a big deal to exchange ${inCurrency} for ${outCurrency}. But I think you made a request by mistake. Better I will try to send transfer back to you. I will validate your transfer and wait for ${min_confirmations} block confirmations. It can take a time, please be patient.`;
	}
	else if (!config.accepted_crypto.includes(inCurrency)){
		pay.error = 5;
		pay.needToSendBack = true;

		msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about incoming transfer of unaccepted crypto: ${inCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}`;

		msgSendBack = `Crypto ${inCurrency} is not accepted. I will try to send transfer back to you. I will validate your transfer and wait for ${min_confirmations} block confirmations. It can take a time, please be patient`;
	}
	else if (!config.exchange_crypto.includes(outCurrency)){
		pay.error = 6;
		pay.needToSendBack = true;

		msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about incoming transfer of unaccepted crypto: ${outCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}`;

		msgSendBack = `I don’t accept exchange to ${outCurrency}. I will try to send transfer back to you. I will validate your transfer and wait for ${min_confirmations} block confirmations. It can take a time, please be patient`;
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
		if (!pay.outAmount){ // cant math outAmount // TODO: messages!
			pay.error = 7;
			pay.needToSendBack = true;

			msgNotify = `Exchange Bot ${Store.user.ADM.address} cant math outAmount.`;

			msgSendBack = `I cant math your request to exchange ${inAmountMessage} ${inCurrency}.`;
		} else { // its Ok
			msgNotify = `Exchange Bot ${Store.user.ADM.address} notifies about incoming transaction for exchange: ${inAmountMessage} ${inCurrency} for price ${pay.exchangePrice}. Tx hash: ${inTxid}. Exchange to ${pay.outAmount} ${outCurrency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`;

			msgSendBack = `I understood your request to exchange ${inAmountMessage} ${inCurrency} for ${pay.outAmount} ${outCurrency} for price ${pay.exchangePrice}. Now I will validate your transfer and wait for ${min_confirmations} block confirmations. It can take a time, please be patient`;
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


// {"type":"ETH_transaction","amount":0.1,"hash":"0x96075435aa404a9cdda0edf40c07e2098435b28547c135278f5864f8398c5d7d","comments":"Testing purposes "}
