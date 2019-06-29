const notify = require('./helpers/notify');
const db = require('./modules/DB');
const Store = require('./modules/Store');
const checker = require('./modules/checkerTransactions');
setTimeout(init, 2000);

function init() {
	require('./server');
	require('./modules/confirmationsCounter');
	require('./modules/exchangePayer');
	require('./modules/sendBack');
	require('./modules/sendedTxValidator');
	try {
		db.systemDb.findOne().then(system => {
			if (system) {
				Store.lastBlock = system.lastBlock;
			} else { // if fst start
				Store.updateLastBlock();
			}
			checker();
			notify(`*Exchange Bot ${Store.botName} started* for address _${Store.user.ADM.address}_.`, 'info');
		});
	} catch (e) {
		notify('Exchange Bot is not started. Error: ' + e, 'error');
	}
}
