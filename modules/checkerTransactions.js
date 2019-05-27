const Storage = require('./Storage');
const api = require('./api');
const config = require('./configReader');
const exchangeTrans = require('./exchangeTrans');
const chatTrans = require('./chatTrans');

function check() {
	const {
		lastHeight
	} = Storage;
	const tx = api.get('uri', 'chats/get/?recipientId=' + config.address + '&orderBy=timestamp:desc&fromHeight=' + lastHeight).transactions;

	tx.forEach(t => {
		const {type} = t;
		if (type === 8 && (t.amount > 1 || typeof type === 'string' && ~type.indexOf('transaction'))) {
			exchangeTrans(t);
		} else if (type === 8) {
			chatTrans(t);
		}
	});
	Storage.updateLastBlock();
}


module.exports = () => {
	setInterval(check, 4500);
};
