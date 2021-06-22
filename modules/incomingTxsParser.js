const db = require('./DB');
const log = require('../helpers/log');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const utils = require('../helpers/utils');
const api = require('./api');
const config = require('./configReader');
const exchangeTxs = require('./exchangeTxs');
const commandTxs = require('./commandTxs');
const unknownTxs = require('./unknownTxs');
const notify = require('../helpers/notify');

const processedTxs = { }; // cache for processed transactions

module.exports = async (tx) => {

	if (!tx) {
		return;
	}

	if (processedTxs[tx.id]) {
		return;
	}

	const {incomingTxsDb} = db;
	const checkedTx = await incomingTxsDb.findOne({txid: tx.id});
	if (checkedTx !== null) {
		return;
	};

	log.info(`New incoming transaction: ${tx.id}`);
	let msg = '';
	console.log('tx', tx)
	const chat = tx.asset.chat;
	if (chat){
		msg = api.decodeMsg(chat.message, tx.senderPublicKey, config.passPhrase, chat.own_message).trim();
	}

	if (msg === '') {
		msg = 'NONE';
	}


	let type = 'unknown';
	if (msg.includes('_transaction') || tx.amount > 0) {
		type = 'exchange';
	} else if (msg.startsWith('/')){
		type = 'command';
	}

	const spamerIsNotyfy = await incomingTxsDb.findOne({
		senderId: tx.senderId,
		isSpam: true,
		date: {$gt: (utils.unix() - 24 * 3600 * 1000)} // last 24h
	});
	const itx = new incomingTxsDb({
		_id: tx.id,
		txid: tx.id,
		date: utils.unix(),
		blockId: tx.blockId,
		encrypted_content: msg,
		spam: false,
		senderId: tx.senderId,
		type, // command, exchange or unknown
		isProcessed: false
	});

	if (msg.toLowerCase().trim() === 'deposit') {
		itx.update({isProcessed: true}, true);
		processedTxs[tx.id] = utils.unix();
		return;
	}

	const countRequestsUser = (await incomingTxsDb.find({
		senderId: tx.senderId,
		date: {$gt: (utils.unix() - 24 * 3600 * 1000)} // last 24h
	})).length;

	if (countRequestsUser > 65 || spamerIsNotyfy) { // 65 per 24h is a limit for accepting commands, otherwise user will be considered as spammer
		itx.update({
			isProcessed: true,
			isSpam: true
		});
	}

	await itx.save();
	if (processedTxs[tx.id]) {
		return;
	}
	processedTxs[tx.id] = utils.unix();

	if (itx.isSpam && !spamerIsNotyfy) {
		notify(`${config.notifyName} notifies _${tx.senderId}_ is a spammer or talks too much. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`, 'warn');
		api.sendMessage(config.passPhrase, tx.senderId, `I’ve _banned_ you. No, really. **Don’t send any transfers as they will not be processed**. Come back tomorrow but less talk, more deal.`);
		return;
	}

	switch (type) {
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
