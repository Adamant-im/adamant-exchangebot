
const db = require('./DB');
const {SAT} = require('../helpers/const');
const $u = require('../helpers/utils');
const notify = require('../helpers/notify');
const api = require('./api');
const config = require('./configReader');
const Store = require('./Store');

module.exports = async (itx, tx) => {
	console.log('--------' + itx._id);
	const {paymentsDb} = db;
	const msg = itx.encrypted_content;
	let in_currency,
		out_currency,
		hash,
		in_amount_message;

	if (tx.amount > 0){ // ADM
		in_amount_message = tx.amount / SAT;
		in_currency = 'ADM';
		out_currency = msg;
	} else if (msg.includes('_transaction')){ // no ADM
		in_currency = msg.match(/"type":"(.*)_transaction/)[1];
		try {
			const json = JSON.parse(msg);
			in_amount_message = json.amount;
			hash = json.hash;
			out_currency = json.comments;
		} catch (e){
			in_currency = false;
		}
	}
	if (typeof out_currency === 'string'){
		out_currency = out_currency.toUpperCase().trim();
	} else {
		out_currency = null;
	}
	const pay = new paymentsDb({
		itx_id: itx._id,
		in_currency,
		out_currency,
		hash,
		validateIsFinish: false,
		in_amount_message
	});
	// Validate
	// console.log({
	// 	in_currency,
	// 	out_currency,
	// 	hash,
	// 	in_amount_message
	// });
	
	let msgSendBack = false;
	let msgNotify = false;
	if (!out_currency){
		msgNotify = msgSendBack = `Exchange Bot ${Store.user.adm.address} no valid comment out_currency!`;
	} else if (in_currency === out_currency){
		msgNotify = `Exchange Bot ${Store.user.adm.address} received request to exchange ${in_currency} for ${out_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`;
		msgSendBack = `Not a big deal to exchange ${in_currency} for ${out_currency}. But I think you made a request by mistake. Better I will try to send transfer back to you. I will validate your transfer and wait for <Min_confirmations> block confirmations. It can take a time, please be patient.`;
	} else if (!config.accepted_crypto.includes(in_currency)){
		msgNotify = `Exchange Bot ${Store.user.adm.address} notifies about incoming transfer of unaccepted crypto: ${in_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}`;
		msgSendBack = `Crypto ${in_currency} is not accepted. I will try to send transfer back to you. I will validate your transfer and wait for <Min_confirmations> block confirmations. It can take a time, please be patient`;
	} else if (!config.exchange_crypto.includes(out_currency)){
		msgNotify = `Exchange Bot ${Store.user.adm.address} notifies about incoming transfer of unaccepted crypto: ${out_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}`;
		msgSendBack = `I don’t accept exchange to ${out_currency}. I will try to send transfer back to you. I will validate your transfer and wait for <Min_confirmations> block confirmations. It can take a time, please be patient`;
	} // TODO: equal USD

	if (msgSendBack){ // Error validate
		pay.update({
			msgSendBack,
			need_to_send_back: true,
			validateIsFinish: true
		}, true);
	
		itx.update({isProcessed: true}, true);
		console.log(itx._id);
		notify(msgNotify, 'warn'); // TODO: send msgSendBack to Adamanте messenger
	} else { // Success validation 
		if (in_currency === 'ADM'){
			itx.validateIsFinish = true;
			
			itx.save();
			
		} else {
			// validatorBlockChain(txs);
		// TODO: если не ADM отправить на 2й валидатор - соответвие данным в БЧ коина
		}
	}
};


// {"type":"ETH_transaction","amount":0.1,"hash":"0x96075435aa404a9cdda0edf40c07e2098435b28547c135278f5864f8398c5d7d","comments":"Testing purposes "}