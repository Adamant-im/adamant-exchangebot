const db = require('./DB');
const log = require('../helpers/log');
const {SAT} = require('../helpers/const');
const $u = require('../helpers/utils');
const api = require('./api');
setTimeout(()=>{
	db.incomingTxsDb.drop();
}, 2000);
module.exports = (params) => {
	const {incomingTxsDb, paymentsDb} = db;
	const {coin, t, msg, data} = params;
	let amount;
	if (coin === 'ADM'){
		amount = t.amount / SAT;
	} else {
		amount = data.amount;
	}
	// TODO: сделать проверку на то что коин доступен к обмену
	incomingTxsDb.findOne({txid: t.id}).then(tx =>{
		if (tx !== null) {
			log.warn(` Transaction dublicate id: ${t.id}`);
			return;
		};
		// Transaction processing
		log.info(`New incoming transaction ${amount} ${coin}`);
		const txs = {
			txid: t.id,
			date: $u.unix(),
			block_id: t.blockId,
			encrypted_content: msg,
			processed: false,
			spam: false,
			sender: t.blockId,
			type: 'exchange',
			coin,
			amount,
			processed: false
		};
		//TODO:
		// Если еще за 24 этого собеседника еще не извещали, то 
		// Notify (red) “Exchange Bot <name> notifies <sender> is a spammer or talks too much. Income ADAMANT Tx: https://explorer.adamant.im/tx/<in_adm_txid>.”
		// Message to sender: “I’ve banned you. No, really. Don’t send any transfers as they will not be processed. Come back tomorrow but less talk, more deal.”
		incomingTxsDb.insertOne(txs, (err, res) =>{
			if (err){
				log.error(' Insert in incoming_txs ' + err);
				return;
			}
			const incoming_tx_id = res.insertedId;
			const pay = {
				incoming_tx_id,
				in_currency: coin,
				finished: false
			};
			// TODO: поверить что валюта доступна в конфиге иначе запись об ошибке
		});
	});
};


// {"type":"ETH_transaction","amount":0.1,"hash":"0x96075435aa404a9cdda0edf40c07e2098435b28547c135278f5864f8398c5d7d","comments":"Testing purposes "}