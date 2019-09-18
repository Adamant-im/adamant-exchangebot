const notify = require('./helpers/notify');
const db = require('./modules/DB');
const Store = require('./modules/Store');
const checker = require('./modules/checkerTransactions');
const doClearDB = process.argv.reverse()[0] === 'clear_db';
setTimeout(init, 5000);

function init() {
	require('./helpers/utils/erc20_utils');
	require('./server');
	require('./modules/confirmationsCounter');
	require('./modules/exchangePayer');
	require('./modules/sendBack');
	require('./modules/sendedTxValidator');
	try {

		// if (true) {
		if (doClearDB) {
			db.systemDb.db.drop();
			db.incomingTxsDb.db.drop();
			db.paymentsDb.db.drop();
			notify(`*Exchange Bot ${Store.botName}: database cleared*.`, 'info');
		}

		db.systemDb.findOne().then(system => {
			if (system) {
				Store.lastBlock = system.lastBlock;
			} else { // if fst start
				Store.updateLastBlock();
			}
			checker();
			notify(`*Exchange Bot ${Store.botName} started* for address _${Store.user.ADM.address}_ (ver. ${Store.version}).`, 'info');
		});
	} catch (e) {
		notify('Exchange Bot is not started. Error: ' + e, 'error');
		process.exit(1);
	}
}
