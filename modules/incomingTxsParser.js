const db = require('./DB');
const log = require('../helpers/log');
const {SAT} = require('../helpers/const');
const $u = require('../helpers/utils');
const api = require('./api');
const config = require('./configReader');
const exchangeTxs = require('./exchangeTxs');
const commandTxs = require('./commandTxs');
const uncnounTxs = require('./uncnounTxs');
const Store = require('./Store');
const notify = require('../helpers/notify');

setTimeout(()=>{
	db.incomingTxsDb.db.drop();
	db.paymentsDb.db.drop();
	
}, 2000);
const historyTxs = {}; // catch saved txs. Defender dublicated
module.exports = async (tx) => {
	if (historyTxs[tx.id]){
		console.log('TX in historyTxs!');
		return;
	}
	historyTxs[tx.id] = $u.unix();

	const {incomingTxsDb} = db;
	const checkedTx = await incomingTxsDb.findOne({txid: tx.id});
	if (checkedTx !== null) {
		log.warn(` Transaction dublicate id: ${tx.id}`);
		return;
	};
	log.info(`New incoming transaction`);
	const chat = tx.asset.chat;
	const msg = api.decodeMsg(chat.message, tx.senderPublicKey, config.passPhrase, chat.own_message);
	let type = 'unknown';
	if (msg.startsWith('/')){
		type = 'command';
	} else if (msg.includes('_transaction') || tx.amount > 0){
		type = "exchange";
	}
	const itx = new incomingTxsDb({
		txid: tx.id,
		date: $u.unix(),
		block_id: tx.blockId,
		encrypted_content: msg,
		spam: false,
		sender: tx.senderId,
		type, // command, exchange или unknown
		isProcessed: false
	});
	
	switch (type){
	case ('exchange'):	
		await itx.save();
		exchangeTxs(itx, tx);
		break;
	case ('command'):
		commandTxs(msg);
		itx.isProcessed = true;
		itx.save();
		break;
	default:
		uncnounTxs(itx, tx);
		itx.isProcessed = true;
		itx.save();
		break;
	}
};
// {"type":"ETH_transaction","amount":0.1,"hash":"0x96075435aa404a9cdda0edf40c07e2098435b28547c135278f5864f8398c5d7d","comments":"Testing purposes "}