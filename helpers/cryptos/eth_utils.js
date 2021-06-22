const config = require('../../modules/configReader');
const log = require('../log');
const Eth = require('web3-eth');
const ethUtils = require('web3-utils');
const utils = require('../utils');
const eth = new Eth(config.node_ETH[0]);// TODO: health check
// const {eth} = eth;
const Store = require('../../modules/Store');
// const EthereumTx = require('ethereumjs-tx').Transaction;
const ethSat = 1000000000000000000;
const User = Store.user.ETH;
eth.defaultAccount = User.address;
eth.defaultBlock = 'latest';
const privateKey = Buffer.from(
	User.privateKey.replace('0x', ''),
	'hex',
);

Store.web3 = eth;

const baseCoin = require('./baseCoin');
module.exports = new class ethCoin extends baseCoin {

	constructor () {
    super()
		this.cache.lastBlock = { lifetime: 10000 };
  }
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
			}).catch(e=> {
				log.warn(`Error while getting Tx ${hash} (if Tx is new, just wait). ${e}`);
			});
		});
	}
	getTransactionStatus(hash) {
		return new Promise(resolve => {
			eth.getTransactionReceipt(hash, (err, tx) => {
				if (err || !tx) {
					resolve(null);
				} else {
					resolve({
						blockNumber: tx.blockNumber,
						status: tx.status
					});
				}
			}).catch(e=> {
				log.error(`Error while getting Tx ${hash} (if Tx is new, just wait). ${e}`);
			});
		});
	}

	getLastBlock() {
		let cached = this.cache.getData('lastBlock');
		if (cached) {
			return cached;
		}
		return new Promise(resolve => {
			eth.getBlock('latest').then(block => {
				if (block) {
					this.cache.cacheData('lastBlock', block);
					resolve(block);
				}
			}).catch(e => {
				log.warn(`Failed to get last block in getLastBlock() of ${utils.getModuleName(module.id)} module. Error: ` + e);
			});
		});
	}

	async getLastBlockHeight() {
		const block = await this.getLastBlock();
		return block ? block.number : undefined;
	}

	updateGasPrice() {
		return new Promise(resolve => {
			eth.getGasPrice().then(price => {
				if (price) {
					this.gasPrice = ethUtils.toHex(price);
				}
				resolve();
			}).catch(e=>{
				log.error('Error while updating Ether gas price: ' + e);
			});
		});
	}

	updateBalance(){
		eth.getBalance(User.address).then(balance => {
			if (balance){
				User.balance = balance / ethSat;
			}
		}).catch(e=>{
			log.error('Error while updating ETH balance: ' + e);
		});
	}

	get FEE() {
		return this.gasPrice * 22000 / ethSat * 2;
	}

	getNonce() {
		return new Promise(resolve => {
			eth.getTransactionCount(User.address).then(nonce => {
				this.currentNonce = nonce;
				resolve(nonce);
			}).catch(e =>{
				log.error('Error while updating ETH nonce: ' + e);
				setTimeout(()=>{
					this.getNonce();
				}, 2000);
			});
		});
	}

	async send(params, contract) {
		try {
			const txParams = {
				nonce: this.currentNonce++,
				gasPrice: this.gasPrice,
				gas: ethUtils.toHex(22000 * 2),
				to: params.address,
				value: params.value * ethSat
			};
			if (contract) { // ERC20
				txParams.value = '0x0';
				txParams.data = contract.data;
				txParams.to = contract.address;
				txParams.gas *= 2;
			}

			// const tx = new EthereumTx(txParams);
			// tx.sign(privateKey);
			// const serializedTx = '0x' + tx.serialize().toString('hex');
			// return new Promise(resolve => {
			// 	eth.sendSignedTransaction(serializedTx)
			// 		.on('transactionHash', (hash) => {
			// 			resolve({
			// 				success: true,
			// 				hash
			// 			});
			// 		}).on('error', (error) => {  // If out of gas error, the second parameter is the receipt
			// 			resolve({
			// 				success: false,
			// 				error
			// 			});
			// 		}).catch(e => {
			// 			if (!e.toString().includes('Failed to check for transaction receipt')) // Known bug that after Tx sent successfully, this error occurred anyway https://github.com/ethereum/web3.js/issues/3145
			// 				log.error('Error while sending ETH tx: ' + e);
			// 		});
			// });
		} catch (e) {
			log.error('Error while executing Ethereum transaction: ' + e);
		}
	}

	lastNonce = 0

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
