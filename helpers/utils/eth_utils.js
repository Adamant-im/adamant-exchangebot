const Web3 = require('web3');
const web3 = new Web3('https://ethnode1.adamant.im');
const {eth} = web3;
const Store = require('../../modules/Store');
const EthereumTx = require('ethereumjs-tx').Transaction;
const ethSat = 1000000000000000000;
eth.defaultAccount = Store.user.ETH.address;
const privateKey = Buffer.from(
	Store.user.ETH.privateKey.replace('0x', ''),
	'hex',
);

module.exports = {
	syncGetTransaction(hash) {
		return new Promise(resolve => {
			eth.getTransaction(hash, (err, tx) => {
				if (err) {
					resolve(null);
				} else {
					resolve({
						blockNumber: tx.blockNumber,
						hash: tx.hash,
						sender: tx.from,
						recipient: tx.to,
						amount: tx.value / ethSat
					});
				}
			});
		});
	},
	getTransactionStatus(hash) {
		return new Promise(resolve => {
			eth.getTransactionReceipt(hash, (err, tx) => {
				if (err) {
					resolve(null);
				} else {
					resolve({
						blockNumber: tx.blockNumber,
						status: tx.status
					});
				}
			});
		});
	},
	getLastBlockNumber() {
		return new Promise(resolve => {
			eth.getBlock('latest').then(block => {
				if (block) {
					resolve(block.number);
				} else {
					resolve(null);
				}
			});
		});
	},
	updateGasPrice() {
		eth.getGasPrice().then(price => {
			if (price) {
				this.gasPrice = web3.utils.toHex(price);
			}
		});
	},
	get FEE() {
		return this.gasPrice * 21000 / ethSat * 3;
	},
	getNonce() {
		return new Promise(resolve => {
			eth.getTransactionCount(Store.user.ETH.address).then(nonce => {
				this.currentNonce = nonce;
				resolve(nonce);
			});
		});
	},
	async send(params) {
		try {
			const txParams = {
				nonce: this.currentNonce++,
				gasPrice: this.gasPrice,
				gas: web3.utils.toHex(22000),
				to: params.address,
				value: params.value * ethSat - this.FEE
			};

			const tx = new EthereumTx(txParams);
			tx.sign(privateKey);
			const serializedTx = '0x' + tx.serialize().toString('hex');
			return new Promise(resolve => {
				eth.sendSignedTransaction(serializedTx)
					.on('transactionHash', (hash) => {
						resolve({
							success: true,
							hash
						});
					}).on('error', (error) => {
						resolve({
							success: false,
							error
						});
					}); // If a out of gas error, the second parameter is the receipt.
			});
		} catch (e) {
			console.log('CATCH' + e);
		}
	},
	lastNonce: 0,
};


// Init
module.exports.updateGasPrice();
module.exports.getNonce();
setInterval(() => {
	module.exports.updateGasPrice();
}, 10 * 1000);
