const notify = require('./helpers/notify');
const db = require('./modules/DB');
const Store = require('./modules/Store');
const checker = require('./modules/checkerTransactions');
const doClearDB = process.argv.includes('clear_db');
const config = require('./modules/configReader');
const txParser = require('./modules/incomingTxsParser');
const exchangerUtils = require('./helpers/cryptos/exchanger')

// Socket connection
const api = require('./modules/api');
api.socket.initSocket({ socket: config.socket, wsType: config.ws_type, onNewMessage: txParser, admAddress: config.address });

// wait for a first nodes' heath check and initialization
setTimeout(init, 5000);

function init() {
	// require('./helpers/cryptos/erc20_utils');
	exchangerUtils.createErc20tokens();
	require('./modules/confirmationsCounter');
	require('./modules/exchangePayer');
	require('./modules/sendBack');
	require('./modules/sentTxChecker');
	try {

		if (doClearDB) {
			console.log('Clearing database..');
			db.systemDb.db.drop();
			db.incomingTxsDb.db.drop();
			db.paymentsDb.db.drop();
			notify(`*${config.notifyName}: database cleared*. Manually stop the Bot now.`, 'info');
		} else {
			// require('./helpers/cryptos/exchanger').ETH.getTransaction('0x02398999363faa9eeabbbfcb39f4ce1ae78900c4308423d048ebe85fbfc1ae05');
			checker();
			notify(`*${config.notifyName} started* for address _${config.address}_ (ver. ${config.version}).`, 'info');
		}

	} catch (e) {
		notify(`${config.notifyName} is not started. Error: ${e}`, 'error');
		process.exit(1);
	}
}
