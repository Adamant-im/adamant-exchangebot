const config = require('../../modules/configReader');
const log = require('../log');
const Web3 = require('web3');
const web3 = new Web3(config.node_ETH[0]);// TODO: health check
const {eth} = web3;
const Store = require('../../modules/Store');
const EthereumTx = require('ethereumjs-tx').Transaction;
const ethSat = 1000000000000000000;
const User = Store.user.ETH;
eth.defaultAccount = User.address;
eth.defaultBlock = 'latest';
const privateKey = Buffer.from(
	User.privateKey.replace('0x', ''),
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
						amount: +(tx.value / ethSat).toFixed(8)
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
		return new Promise(resolve => {
			eth.getGasPrice().then(price => {
				if (price) {
					this.gasPrice = web3.utils.toHex(price);
				}
				resolve();
			}).catch(e=>{
				log.error('Update ETH GAS ' + e);
			});
		});
	},
	updateBalance(){
		eth.getBalance(User.address).then((err, balance) => {
			if (!err){
				User.balance = balance / ethSat;
			}
		}).catch(e=>{
			log.error('Update ETH balance ' + e);
		});
	},
	get FEE() {
		return this.gasPrice * 22000 / ethSat * 2;
	},
	getNonce() {
		return new Promise(resolve => {
			eth.getTransactionCount(User.address).then(nonce => {
				this.currentNonce = nonce;
				resolve(nonce);
			}).catch(e =>{
				log.error('Update ETH nonce ' + e);
				setTimeout(()=>{
					this.getNonce();
				}, 2000);
			});
		});
	},
	async send(params) {
		try {
			const txParams = {
				nonce: this.currentNonce++,
				gasPrice: this.gasPrice,
				gas: web3.utils.toHex(22000 * 2),
				to: params.address,
				value: params.value * ethSat
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
			log.error('Error executing Ethereum transaction: ' + e);
		}
	},
	lastNonce: 0,
};

// Init
module.exports.updateGasPrice();
module.exports.updateBalance();
module.exports.getNonce();

setInterval(() => {
	module.exports.updateGasPrice();
}, 10 * 1000);

setInterval(() => {
	module.exports.updateBalance();
}, 60 * 1000);
