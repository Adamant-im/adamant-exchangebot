const notify = require('./helpers/notify');
const db = require('./modules/DB');
const Store = require('./modules/Store');
const checker = require('./modules/checkerTransactions');
setTimeout(init, 2000);

function init() {
	require('./server');
	require('./modules/confirmationsCounter');
	try {
		db.systemDb.findOne().then(system => {
			if (system) {
				Store.lastBlock = system.lastBlock;
			} else { // if fst start
				Store.updateLastBlock();
			}
			checker();
		});
	} catch (e) {
		notify('Exchange Bot is not started. Some kind of error ' + e, 'error');
	}
}
