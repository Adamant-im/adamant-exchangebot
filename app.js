const notify = require('./helpers/notyfy');
const db = require('./modules/DB');
const Storage = require('./modules/Storage');
const checker = require('./modules/checkerTransactions');
setTimeout(init, 2000);

function init() {
	require('./server');
	try {
		db.system.findOne().then(system => {
			if (system) {
				Storage.lastBlock = system.lastBlock;
			} else { // if fst start
				Storage.updateLastBlock();
			}
			checker();
		});
	} catch (e) {
		notify('Exchange Bot is not started. Some kind of error ' + e, 'error');
	}
}
