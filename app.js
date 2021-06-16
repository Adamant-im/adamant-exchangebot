const notify = require('./helpers/notify');
const db = require('./modules/DB');
const Store = require('./modules/Store');
const checker = require('./modules/checkerTransactions');
const doClearDB = process.argv.includes('clear_db');
const config = require('./modules/configReader');
const txParser = require('./modules/incomingTxsParser');

// Socket connection
const api = require('./modules/api');
api.socket.initSocket({socket: config.socket, wsType: config.ws_type, onNewMessage: txParser, admAddress: Store.user.ADM.address});

setTimeout(init, 5000);

function init() {
	require('./helpers/cryptos/erc20_utils');
	require('./server');
	require('./modules/confirmationsCounter');
	require('./modules/exchangePayer');
	require('./modules/sendBack');
	require('./modules/sendedTxValidator');
	try {

		if (doClearDB) {
			console.log('Clearing database..');
			db.systemDb.db.drop();
			db.incomingTxsDb.db.drop();
			db.paymentsDb.db.drop();
			notify(`*${config.notifyName}: database cleared*. Manually stop the Bot now.`, 'info');
		} else {

			db.systemDb.findOne().then(system => {
				if (system) {
					Store.lastBlock = system.lastBlock;
				} else { // if 1st start
					Store.updateLastBlock();
				}
				checker();
				notify(`*${config.notifyName} started* for address _${Store.user.ADM.address}_ (ver. ${Store.version}).`, 'info');
			});
		}

	} catch (e) {
		notify(`${config.notifyName} is not started. Error: ${e}`, 'error');
		process.exit(1);
	}
}
