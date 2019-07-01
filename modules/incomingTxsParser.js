const db = require('./DB');
const log = require('../helpers/log');
const $u = require('../helpers/utils');
const api = require('./api');
const config = require('./configReader');
const exchangeTxs = require('./exchangeTxs');
const commandTxs = require('./commandTxs');
const unknownTxs = require('./unknownTxs');
const notify = require('../helpers/notify');
const Store = require('./Store');

const historyTxs = {}; // catch saved txs. Defender dublicated TODO: clear uptime

module.exports = async (tx) => {
	if (historyTxs[tx.id]){
		return;
	}

	const {incomingTxsDb} = db;
	const checkedTx = await incomingTxsDb.findOne({txid: tx.id});
	if (checkedTx !== null) {
		return;
	};
	
	log.info(`New incoming transaction: ${tx.id}`);
	let msg = '';
	const chat = tx.asset.chat;
	if (chat){
		msg = api.decodeMsg(chat.message, tx.senderPublicKey, config.passPhrase, chat.own_message).trim();
	}
	
	console.log({chat, msg});
	if (msg === ''){
		msg = 'NONE';
	}

	let topUpTransaction = false;
	if (msg.toUpperCase() === 'TOP_UP'){
		topUpTransaction = true;
	}

	let type = 'unknown';
	if (msg.includes('_transaction') || tx.amount > 0){
		type = 'exchange';
	} else if (msg.startsWith('/')){
		type = 'command';
	}

	const spamerIsNotyfy = await incomingTxsDb.findOne({
		sender: tx.senderId,
		isSpam: true,
		date: {$gt: ($u.unix() - 24 * 3600 * 1000)} // last 24h
	});
	const itx = new incomingTxsDb({
		_id: tx.id,
		txid: tx.id,
		date: $u.unix(),
		block_id: tx.blockId,
		encrypted_content: msg,
		spam: false,
		sender: tx.senderId,
		type, // command, exchange or unknown
		isProcessed: false
	});

	const countRequestsUser = (await incomingTxsDb.find({
		sender: tx.senderId,
		date: {$gt: ($u.unix() - 24 * 3600 * 1000)} // last 24h
	})).length;

	if (countRequestsUser > 65 || spamerIsNotyfy){
		itx.update({
			isProcessed: true,
			isSpam: true
		});
	}

	if (topUpTransaction){
		itx.update({
			isProcessed: true
		});
		return;
	}

	await itx.save();
	if (historyTxs[tx.id]){
		return;
	}
	historyTxs[tx.id] = $u.unix();

	if (itx.isSpam && !spamerIsNotyfy){
		notify(`Exchange Bot ${Store.botName} notifies _${tx.senderId}_ is a spammer or talks too much. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`, 'warn');
		$u.sendAdmMsg(tx.senderId, `I’ve _banned_ you. No, really. **Don’t send any transfers as they will not be processed**.
		 Come back tomorrow but less talk, more deal.`);
		return;
	}

	switch (type){
	case ('exchange'):
		exchangeTxs(itx, tx);
		break;
	case ('command'):
		commandTxs(msg, tx, itx);
		break;
	default:
		unknownTxs(tx, itx);
		break;
	}
};
