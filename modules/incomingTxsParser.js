const db = require('./DB');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const utils = require('../helpers/utils');
const api = require('./api');
const config = require('./configReader');
const constants = require('../helpers/const');
const exchangeTxs = require('./exchangeTxs');
const commandTxs = require('./commandTxs');
const unknownTxs = require('./unknownTxs');
const Store = require('./Store');

const processedTxs = {}; // cache for processed transactions

module.exports = async (tx) => {

	// do not process one Tx twice: first check in cache, then check in DB
	if (processedTxs[tx.id]) {
		if (!processedTxs[tx.id].height) {
			await updateProcessedTx(tx, null, true); // update height of Tx and last processed block
		}
		return;
	}
	const { incomingTxsDb } = db;
	const knownTx = await incomingTxsDb.findOne({ txid: tx.id });
	if (knownTx !== null) {
		if (!knownTx.height || !processedTxs[tx.id]) {
			await updateProcessedTx(tx, knownTx, knownTx.height && processedTxs[tx.id]); // update height of Tx and last processed block
		}
		return;
	};

	log.log(`Processing new incoming transaction ${tx.id} from ${tx.recipientId} via ${tx.height ? 'REST' : 'socket'}…`);

	let decryptedMessage = '';
	const chat = tx.asset ? tx.asset.chat : '';
	if (chat) {
		decryptedMessage = api.decodeMsg(chat.message, tx.senderPublicKey, config.passPhrase, chat.own_message).trim();
	}
	if (decryptedMessage === '') {
		decryptedMessage = 'NONE';
	}

	let messageDirective = 'unknown';
	if (decryptedMessage.includes('_transaction') || tx.amount > 0) {
		messageDirective = 'exchange';
	} else if (decryptedMessage.startsWith('/')) {
		messageDirective = 'command';
	}

	const spamerIsNotyfy = await incomingTxsDb.findOne({
		senderId: tx.senderId,
		isSpam: true,
		date: { $gt: (utils.unix() - 24 * 3600 * 1000) } // last 24h
	});

	const itx = new incomingTxsDb({
		_id: tx.id,
		txid: tx.id,
		date: utils.unix(),
		timestamp: tx.timestamp,
		amount: tx.amount,
		fee: tx.fee,
		type: tx.type,
		senderId: tx.senderId,
		senderPublicKey: tx.senderPublicKey,
		recipientId: tx.recipientId, // it is me!
		recipientPublicKey: tx.recipientPublicKey,
		messageDirective, // command, exchange or unknown
		decryptedMessage,
		spam: false,
		isProcessed: false,
		// these will be undefined, when we get Tx via socket. Actually we don't need them, store them for a reference
		blockId: tx.blockId,
		height: tx.height,
		block_timestamp: tx.block_timestamp,
		confirmations: tx.confirmations,
		// these will be undefined, when we get Tx via REST
		relays: tx.relays,
		receivedAt: tx.receivedAt
	});

	if (decryptedMessage.toLowerCase() === 'deposit') {
		await itx.update({ isProcessed: true }, true);
		await updateProcessedTx(tx, itx, false);
		api.sendMessage(config.passPhrase, tx.senderPublicKey, `I've got a top-up transfer from you. Thanks, bro.`);
		notify(`${config.notifyName} got a top-up transfer from ${tx.recipientId}. The exchanger will not validate it, do it manually. Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${tx.id}.`, 'info');	
		return;
	}

	const countRequestsUser = (await incomingTxsDb.find({
		senderId: tx.senderId,
		date: { $gt: (utils.unix() - 24 * 3600 * 1000) } // last 24h
	})).length;

	if (countRequestsUser > 65 || spamerIsNotyfy) { // 65 per 24h is a limit for accepting commands, otherwise user will be considered as spammer
		await itx.update({
			isProcessed: true,
			isSpam: true
		});
	}

	await itx.save();
	await updateProcessedTx(tx, itx, false);

	if (itx.isSpam && !spamerIsNotyfy) {
		notify(`${config.notifyName} notifies _${tx.senderId}_ is a spammer or talks too much. Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${tx.id}.`, 'warn');
		api.sendMessage(config.passPhrase, tx.senderId, `I’ve _banned_ you. No, really. **Don’t send any transfers as they will not be processed**. Come back tomorrow but less talk, more deal.`);
		return;
	}

	switch (messageDirective) {
		case ('exchange'):
			exchangeTxs(itx, tx);
			break;
		case ('command'):
			commandTxs(decryptedMessage, tx, itx);
			break;
		default:
			unknownTxs(tx, itx);
			break;
	}

};

async function updateProcessedTx(tx, itx, updateDb) {

	processedTxs[tx.id] = {
		updated: utils.unix(),
		height: tx.height
	}

	if (updateDb && !itx) {
		itx = await db.incomingTxsDb.findOne({ txid: tx.id });
	}

	if (updateDb && itx) {
		await itx.update({
			blockId: tx.blockId,
			height: tx.height,
			block_timestamp: tx.block_timestamp,
			confirmations: tx.confirmations
		}, true);
	}
	
	await Store.updateLastProcessedBlockHeight(tx.height);

}