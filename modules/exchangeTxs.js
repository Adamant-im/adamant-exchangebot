
const db = require('./DB');
const {SAT} = require('../helpers/const');
const $u = require('../helpers/utils');
const notify = require('../helpers/notify');
const api = require('./api');
const config = require('./configReader');
const Store = require('./Store');

module.exports = async (itx, tx) => {
	const {paymentsDb} = db;
	const msg = itx.encrypted_content;
	let in_currency,
		out_currency,
		in_txid,
		in_amount_message;

	if (tx.amount > 0){ // ADM
		in_amount_message = tx.amount / SAT;
		in_currency = 'ADM';
		out_currency = msg;
		in_txid = tx.id;
	} else if (msg.includes('_transaction')){ // no ADM
		in_currency = msg.match(/"type":"(.*)_transaction/)[1];
		try {
			const json = JSON.parse(msg);
			in_amount_message = Number(json.amount);
			in_txid = json.hash;
			out_currency = json.comments;
		} catch (e){
			in_currency = 'none';
		}
	}

	if (typeof out_currency === 'string'){
		out_currency = out_currency.toUpperCase().trim();
	}
	const pay = new paymentsDb({
		date: $u.unix(),
		itx_id: itx._id,
		senderId: tx.senderId,
		in_currency,
		out_currency,
		in_txid,
		try_counter: 0,
		in_amount_message,
		transactionIsValid: false,
		validateIsFinish: false,
		needHumanCheck: false,
		needToSendBack: false,
		isFinished: false
	});
	// Validate

	let msgSendBack = false;
	let msgNotify = false;
	const in_txid_dublicate = await paymentsDb.findOne({in_txid});

	// Checkers
	if (in_txid_dublicate){
		pay.isFinished = true;
		msgNotify = `Exchange Bot ${Store.user.adm.address} thinks transaction of ${in_amount_message} ${in_currency} is duplicated. Tx hash: ${in_txid}. Income ADAMANT Tx: https://explorer.adamant.im/tx/<in_adm_txid>.. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`;
		msgSendBack = `I think transaction of ${in_amount_message} ${in_currency} with Tx ID ${in_txid} is duplicated, it will not be processed. If you think it’s a mistake, contact my master.`;
	}
	else if (!config.known_crypto.includes(in_currency)){
		pay.needHumanCheck = true;
		msgNotify = `Exchange Bot ${Store.user.adm.address} notifies about incoming transfer of unknown crypto: ${in_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`;
		msgSendBack = `I don’t know crypto {in_currency}. If you think it’s a mistake, contact my master.`;
	}
	else if (!config.known_crypto.includes(out_currency)){
		pay.needToSendBack = true;
		msgNotify = `Exchange Bot ${Store.user.adm.address} notifies about request of unknown crypto: ${out_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`;
		msgSendBack = `I don’t know crypto ${out_currency}. I will try to send transfer back to you. I will validate your transfer and wait for <Min_confirmations> block confirmations. It can take a time, please be patient.`;
	}
	else if (in_currency === out_currency){
		pay.needToSendBack = true;
		msgNotify = `Exchange Bot ${Store.user.adm.address} received request to exchange ${in_currency} for ${out_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`;
		msgSendBack = `Not a big deal to exchange ${in_currency} for ${out_currency}. But I think you made a request by mistake. Better I will try to send transfer back to you. I will validate your transfer and wait for <Min_confirmations> block confirmations. It can take a time, please be patient.`;
	}
	else if (!config.accepted_crypto.includes(in_currency)){
		pay.needToSendBack = true;
		msgNotify = `Exchange Bot ${Store.user.adm.address} notifies about incoming transfer of unaccepted crypto: ${in_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}`;
		msgSendBack = `Crypto ${in_currency} is not accepted. I will try to send transfer back to you. I will validate your transfer and wait for <Min_confirmations> block confirmations. It can take a time, please be patient`;
	}
	else if (!config.exchange_crypto.includes(out_currency)){
		pay.needToSendBack = true;
		msgNotify = `Exchange Bot ${Store.user.adm.address} notifies about incoming transfer of unaccepted crypto: ${out_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}`;
		msgSendBack = `I don’t accept exchange to ${out_currency}. I will try to send transfer back to you. I will validate your transfer and wait for <Min_confirmations> block confirmations. It can take a time, please be patient`;
	}
	// TODO: equal USD
	// TODO: Daily_limit_usd

	if (pay.needHumanCheck || pay.isFinished){
		pay.update({
			isFinished: true,
			validateIsFinish: true
		});
		notify(msgNotify, 'error');
	} else if (pay.needToSendBack){ // Error validate
		notify(msgNotify, 'warn'); // TODO: send msgSendBack to Adamanте messenger
	} else {
		// TODO: computed out amount
	}
	if (msgSendBack){
		api.send(config.passPhrase, tx.senderId, msgSendBack, 'message');
	}
	pay.save();
	itx.update({isProcessed: true}, true);
};


// {"type":"ETH_transaction","amount":0.1,"hash":"0x96075435aa404a9cdda0edf40c07e2098435b28547c135278f5864f8398c5d7d","comments":"Testing purposes "}
