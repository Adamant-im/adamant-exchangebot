const notify = require('./helpers/notify');
const db = require('./modules/DB');
const checker = require('./modules/checkerTransactions');
const doClearDB = process.argv.includes('clear_db');
const config = require('./modules/configReader');
const txParser = require('./modules/incomingTxsParser');
const exchangerUtils = require('./helpers/cryptos/exchanger');

// Socket connection
const api = require('./modules/api');
api.socket.initSocket({ socket: config.socket, wsType: config.ws_type, onNewMessage: txParser, admAddress: config.address });

// wait for a first nodes' heath check and initialization
setTimeout(init, 5000);

function init() {
	// require('./helpers/cryptos/erc20_utils');
	exchangerUtils.createErc20tokens();
	require('./modules/confirmationsCounter');
	require('./modules/deepExchangeValidator');
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
			let x = require('./helpers/cryptos/exchanger').DASH;
			setTimeout(async () => {
				let x1 = await x.getTransaction('2215d17e58b12d7e3c11a3f6d189757910e3fbe57ef2c5f08a96b10df7f07772');
				console.log(x1);
					}, 0)

			// console.log(api.eth.keys(config.passPhrase));
			// console.log(api.dash.keys(config.passPhrase));
			// require('./helpers/cryptos/exchanger').ETH.getTransaction('0x02398999363faa9eeabbbfcb39f4ce1ae78900c4308423d048ebe85fbfc1ae05');
			// require('./helpers/cryptos/exchanger').BZ.send({
			// 	address: '0x5ec346dba5d9315ca068e9e34c85fe9d78c44f2f',
			// 	value: 0.25628672,
			// 	comment: 'Done! Thank you for business. Hope to see you again.' // if ADM
			// });
			// setTimeout(() => {
 			// console.log(require('./helpers/cryptos/exchanger').ETH.FEE)
			//  console.log(require('./helpers/cryptos/exchanger').BZ.FEE)
			//  console.log(require('./helpers/cryptos/exchanger').RES.FEE)
			// 	}, 5000)

			checker();
			notify(`*${config.notifyName} started* for address _${config.address}_ (ver. ${config.version}).`, 'info');
		}

	} catch (e) {
		notify(`${config.notifyName} is not started. Error: ${e}`, 'error');
		process.exit(1);
	}
}
