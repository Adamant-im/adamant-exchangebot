const db = require('./DB');
const log = require('../helpers/log');
const {SAT} = require('../helpers/const');
const $u = require('../helpers/utils');
const api = require('./api');
const config = require('./configReader');
const Store = require('./Store');
const notify = require('../helpers/notify');
setTimeout(()=>{
	try {
		db.incomingTxsDb.db.drop();
	} catch (e) {}
}, 2000);
module.exports = async (params) => {
	const {incomingTxsDb} = db;
	const {coin, t, msg, data} = params;
	const in_currency = coin;
	let in_amount_message = Number(data.amount || t.amount / SAT);
	let request = data;
	if (in_currency !== 'ADM') {
		try {
			request = JSON.parse(data.comments);
		} catch (e){
			request = {};
		}
	}
	
	let out_currency = request.coin;
	if (typeof out_currency === 'string'){
		out_currency = out_currency.toUpperCase().trim();
	}
	const isExchange = request.type === 'exchange';

	const checkedTx = await incomingTxsDb.findOne({txid: t.id});
	if (checkedTx !== null) {
		log.warn(` Transaction dublicate id: ${t.id}`);
		return;
	};

	// Transaction processing

	//TODO:
	// Если еще за 24 этого собеседника еще не извещали, то 
	// Notify (red) “Exchange Bot <name> notifies <sender> is a spammer or talks too much. Income ADAMANT Tx: https://explorer.adamant.im/tx/<in_adm_txid>.”
	// Message to sender: “I’ve banned you. No, really. Don’t send any transfers as they will not be processed. Come back tomorrow but less talk, more deal.”
	log.info(`New incoming transaction ${in_amount_message} ${coin}`);
	const txs = new incomingTxsDb({
		txid: t.id,
		date: $u.unix(),
		block_id: t.blockId,
		encrypted_content: msg,
		spam: false,
		sender: t.senderId,
		type: request.type,
		in_currency,
		out_currency,
		in_amount_message,
		isProcessed: false,
		need_to_send_back: false,
		validateIsFinish: false
	});

	let msgSendBack = false;
	let msgNotify = false;
	if (!isExchange || !out_currency || isNaN(in_amount_message)){
		msgNotify = msgSendBack = `Exchange Bot ${Store.user.adm.address} no valid request!`;
	} else if (in_currency === out_currency){
		msgNotify = `Exchange Bot ${Store.user.adm.address} received request to exchange ${in_currency} for ${out_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${t.id}.`;
		msgSendBack = `Not a big deal to exchange ${in_currency} for ${out_currency}. But I think you made a request by mistake. Better I will try to send transfer back to you. I will validate your transfer and wait for <Min_confirmations> block confirmations. It can take a time, please be patient.`;
	} else if (!config.accepted_crypto.includes[in_currency]){
		msgNotify = `Exchange Bot ${Store.user.adm.address} notifies about incoming transfer of unaccepted crypto: ${in_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${t.id}`;
		msgSendBack = `Crypto ${in_currency} is not accepted. I will try to send transfer back to you. I will validate your transfer and wait for <Min_confirmations> block confirmations. It can take a time, please be patient`;
	} else if (!config.exchange_crypto.includes[out_currency]){
		msgNotify = `Exchange Bot ${Store.user.adm.address} notifies about incoming transfer of unaccepted crypto: ${out_currency}. Income ADAMANT Tx: https://explorer.adamant.im/tx/${t.id}`;
		msgSendBack = `I don’t accept exchange to ${out_currency}. I will try to send transfer back to you. I will validate your transfer and wait for <Min_confirmations> block confirmations. It can take a time, please be patient`;
	} // TODO: equal USD

	if (msgSendBack){ // Error validate
		txs.update({
			isProcessed: true,
			msgSendBack,
			need_to_send_back: true,
			validateIsFinish: true
		}, true);
		notify(msgNotify, 'warn'); // TODO: send msgSendBack to Adamanте messenger
	} else {
		await txs.save();
		if (in_currency !== 'ADM'){
		// validatorBlockChain(txs);
		// TODO: если не ADM отправить на 2й валидатор - соответвие данным в БЧ коина
		}
	}
};

// {"type": "exchange", "coin": "ADM"}
// {"type":"ETH_transaction","amount":0.1,"hash":"0x96075435aa404a9cdda0edf40c07e2098435b28547c135278f5864f8398c5d7d","comments":"Testing purposes "}