const config = require('../../modules/configReader');
const log = require('../log');
const api = require('../../modules/api');
const constants = require('../const');

const Eth = require('web3-eth');
const ethUtils = require('web3-utils');
const utils = require('../utils');
const eth = new Eth(config.node_ETH[0]);// TODO: health check
// const {eth} = eth;
const Store = require('../../modules/Store');
// const EthereumTx = require('ethereumjs-tx').Transaction;
const ethSat = 1000000000000000000;
Store.web3 = eth;

const baseCoin = require('./baseCoin');
module.exports = new class ethCoin extends baseCoin {

	lastNonce = 0

	constructor () {
    super()
		this.token = 'ETH';
		this.cache.lastBlock = { lifetime: 10000 };
		this.cache.balance = { lifetime: 30000 };
		this.account.keysPair = api.eth.keys(config.passPhrase);
		this.account.address = this.account.keysPair.address;
		this.account.privateKey = this.account.keysPair.privateKey;
		this.account.privateKeyBuffer = Buffer.from(this.account.privateKey.replace('0x', ''), 'hex');
		eth.defaultAccount = this.account.address;
		eth.defaultBlock = 'latest';
		this.getBalance().then((balance) => log.log(`Initial ${this.token} balance: ${balance.toFixed(constants.PRINT_DECIMALS)}`));
  }

	get FEE() {
		return this.gasPrice * 22000 / ethSat * 2;
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

  /**
   * Returns balance in ETH from cache, if it's up to date. If not, makes an API request and updates cached data.
   * @returns {Number} or outdated cached value, if unable to fetch data; it may be undefined also
   */
	async getBalance() {
		try {

			let cached = this.cache.getData('balance');
			if (cached) {
				return +ethUtils.fromWei(cached);
			}
			const balance = await eth.getBalance(this.account.address);
			if (balance) {
				this.cache.cacheData('balance', balance);
				return +ethUtils.fromWei(balance);
			} else {
				log.warn(`Failed to get balance in getBalance() of ${utils.getModuleName(module.id)} module; returning outdated cached balance. ${account.errorMessage}.`);
				return +ethUtils.fromWei(cached);
			}

		} catch (e) {
			log.warn(`Error while getting balance in getBalance() of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

  /**
   * Returns balance in ETH from cache. It may be outdated.
   * @returns {Number} cached value; it may be undefined
   */
	get balance() {
		try {
			return +ethUtils.fromWei(this.cache.getData('balance'));
		} catch (e) {
			log.warn(`Error while getting balance in balance() of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

  /**
   * Updates balance in ETH manually from cache. Useful when we don't want to wait for network update.
	 * @param {Number} value New balance in ETH
   */
	set balance(value) {
		try {
			if (utils.isPositiveOrZeroNumber(value)) {
				this.cache.cacheData('balance', ethUtils.toWei(String(value)));
			}
		} catch (e) {
			log.warn(`Error setting balance in balance() of ${utils.getModuleName(module.id)} module: ` + e);
		}		
	}

	getTransactionDetails(hash) {
		return new Promise(resolve => {
			eth.getTransaction(hash, (err, tx) => {
				if (err) {
					resolve(null);
				} else {
					resolve({
						blockId: tx.blockNumber,
						hash: tx.hash,
						senderId: tx.from,
						recipientId: tx.to,
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
						blockId: tx.blockNumber,
						status: tx.status
					});
				}
			}).catch(e=> {
				log.error(`Error while getting Tx ${hash} (if Tx is new, just wait). ${e}`);
			});
		});
	}

	getNonce() {
		return new Promise(resolve => {
			eth.getTransactionCount(this.account.address).then(nonce => {
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
			// tx.sign(this.account.privateKeyBuffer);
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

};

// Init
module.exports.updateGasPrice();
// module.exports.updateBalance();
module.exports.getNonce();

setInterval(() => {
	module.exports.updateGasPrice();
}, 10 * 1000);

setInterval(() => {
	// module.exports.updateBalance();
}, 60 * 1000);
