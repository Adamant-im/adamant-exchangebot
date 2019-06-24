const db = require('./DB');
const log = require('../helpers/log');
const $u = require('../helpers/utils');
const api = require('./api');
const config = require('./configReader');
const exchangeTxs = require('./exchangeTxs');
const commandTxs = require('./commandTxs');
const unknounTxs = require('./unknounTxs');

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
	const chat = tx.asset.chat;
	const msg = api.decodeMsg(chat.message, tx.senderPublicKey, config.passPhrase, chat.own_message);

	let type = 'unknown';
	if (msg.startsWith('/')){
		type = 'command';
	} else if (msg.includes('_transaction') || tx.amount > 0){
		type = 'exchange';
	}

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

	const countRequestsUser = (await db.incomingTxsDb.find({
		senderId: tx.senderId,
		date: {$gt: ($u.unix() - 24 * 3600 * 1000)} // last 24h
	}));

	console.log({countRequestsUser});
	if (countRequestsUser > 100){
		itx.update({
			isProcessed: true,
			isSpam: true
		});
	}

	await itx.save();
	if (historyTxs[tx.id]){
		return;
	}
	historyTxs[tx.id] = $u.unix();

	if (itx.isSpam){
		return;
	}

	switch (type){
	case ('exchange'):
		exchangeTxs(itx, tx);
		break;
	case ('command'):
		commandTxs(msg);
		break;
	default:
		unknounTxs(tx);
		break;
	}
};


// {"type":"ETH_transaction","amount":0.1,"hash":"0x96075435aa404a9cdda0edf40c07e2098435b28547c135278f5864f8398c5d7d","comments":"Testing purposes "}
