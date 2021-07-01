const config = require('../../modules/configReader');
const log = require('../log');
const api = require('../../modules/api');
const constants = require('../const');
const utils = require('../utils');
const erc20models = require('./erc20_models');

const Eth = require('web3-eth');
const ethUtils = require('web3-utils');
const eth = new Eth(config.node_ETH[0]); // TODO: health check
const updateGasPriceInterval = 60 * 1000; // Update gas price every minute

const baseCoin = require('./baseCoin');
module.exports = class ethCoin extends baseCoin {

	lastNonce = 0
	gasPrice = '0' // in wei, string
	gasLimit = 22000 // const gas limit in wei

	constructor(token) {
		super()
		this.token = token;
		this.cache.balance = { lifetime: 30000 }; // in wei, string

		if (token === 'ETH') {
			this.reliabilityCoef = 1.3 // make sure exchanger's Tx will be accepted for ETH
			this.cache.lastBlock = { lifetime: 10000 };
			this.account.keysPair = api.eth.keys(config.passPhrase);
			this.account.address = this.account.keysPair.address;
			this.account.privateKey = this.account.keysPair.privateKey;
			eth.accounts.wallet.add(this.account.privateKey);
			eth.defaultAccount = this.account.address;
			eth.defaultBlock = 'latest';
			this.updateGasPrice().then(() => {
				log.log(`Estimate ${this.token} gas price: ${this.gasPrice ? this.fromSat(this.gasPrice).toFixed(constants.PRINT_DECIMALS) : 'unable to calculate'}`);
				log.log(`Estimate ${this.token} Tx fee: ${this.FEE ? this.FEE.toFixed(constants.PRINT_DECIMALS) : 'unable to calculate'}`);
			});
			setInterval(() => {
				this.updateGasPrice();
			}, updateGasPriceInterval);			
		} else {
			this.reliabilityCoef = 1.8 // make sure exchanger's Tx will be accepted for ERC20
			this.erc20model = erc20models[token];
			this.contract = new eth.Contract(abiArray, this.erc20model.sc, {from: this.account.address});	
		}
		setTimeout(() => this.getBalance().then((balance) => log.log(`Initial ${this.token} balance: ${balance ? balance.toFixed(constants.PRINT_DECIMALS) : 'unable to receive'}`)), 1000);
	}

	/**
	 * Returns estimate Tx fee in ETH for regular or contract Tx
	 * @returns {Number}
	 */
	get FEE() {
		try {
			return +ethUtils.fromWei(String(+this.gasPrice * this.gasLimit)) * this.reliabilityCoef;
		} catch (e) {
			log.warn(`Error while calculating Tx fee in FEE() of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

	/**
	 * Caches gas price in wei. For ETH only, ERC20 tokens don't call it.
	 */
	updateGasPrice() {
		return new Promise(resolve => {
			eth.getGasPrice().then(price => {
				if (price) {
					this.gasPrice = price;
				} else {
					log.warn(`Failed to get Ether gas price in updateGasPrice() of ${utils.getModuleName(module.id)} module. Received value: ` + price);
				}
				resolve();
			}).catch(e => {
				log.warn(`Error while getting Ether gas price in updateGasPrice() of ${utils.getModuleName(module.id)} module. Error: ` + e);
				resolve();
			});
		});
	}

	/**
	 * Returns last block of Ethereum blockchain. ERC20 tokens redirects to ETH instance.
	 * @returns {Object}
	 */
	getLastBlock() {
		let cached = this.cache.getData('lastBlock');
		if (cached) {
			return cached;
		}
		return new Promise(resolve => {
			eth.getBlock('latest').then(block => {
				if (block) {
					this.cache.cacheData('lastBlock', block);
				} else {
					log.warn(`Failed to get last block in getLastBlock() of ${utils.getModuleName(module.id)} module. Received value: ` + block);
				}
				resolve(block);
			}).catch(e => {
				log.warn(`Error while getting last block in getLastBlock() of ${utils.getModuleName(module.id)} module. Error: ` + e);
				resolve();
			});
		});
	}

	/**
	 * Returns last block height of Ethereum blockchain. ERC20 tokens redirects to ETH instance.
	 * @returns {Number}
	 */
	async getLastBlockHeight() {
		const block = await this.getLastBlock();
		return block ? block.number : undefined;
	}

	/**
	 * Converts amount in sat to token. ERC20 overrides this method.
	 * @returns {Number}
	 */
	fromSat(satValue) {
		try {
			return +ethUtils.fromWei(String(satValue))
		} catch (e) {
			log.warn(`Error while converting fromSat(${satValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

	/**
	 * Converts amount in token to sat. ERC20 overrides this method.
	 * @returns {String}
	 */
	toSat(tokenValue) {
		try {
			return ethUtils.toWei(String(tokenValue))
		} catch (e) {
			log.warn(`Error while converting toSat(${tokenValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

	/**
	 * Returns ETH or ERC20 balance from cache, if it's up to date. If not, makes an API request and updates cached data.
	 * Cache stores balance in wei (string)
	 * @returns {Number} or outdated cached value, if unable to fetch data; it may be undefined also
	 */
	async getBalance() {
		try {

			let cached = this.cache.getData('balance');
			if (cached) {
				return this.fromSat(cached);
			}
			let balance;
			if (this.contract) {
				balance = await this.contract.methods.balanceOf(this.account.address).call()
			} else {
				balance = await eth.getBalance(this.account.address);
			}
			if (balance) {
				this.cache.cacheData('balance', balance);
				return this.fromSat(balance);
			} else {
				log.warn(`Failed to get balance in getBalance() of ${utils.getModuleName(module.id)} module; returning outdated cached balance. ${account.errorMessage}.`);
				return this.fromSat(cached);
			}

		} catch (e) {
			log.warn(`Error while getting balance in getBalance() of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

	/**
	 * Returns balance ETH or ERC20 balance from cache. It may be outdated.
	 * @returns {Number} cached value; it may be undefined
	 */
	get balance() {
		try {
			return this.fromSat(this.cache.getData('balance'));
		} catch (e) {
			log.warn(`Error while getting balance in balance() of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

	/**
	 * Updates ETH or ERC20 balance in cache. Useful when we don't want to wait for network update.
	 * @param {Number} value New balance in ETH or token
	 */
	set balance(value) {
		try {
			if (utils.isPositiveOrZeroNumber(value)) {
				this.cache.cacheData('balance', this.toSat(value));
			}
		} catch (e) {
			log.warn(`Error setting balance in balance() of ${utils.getModuleName(module.id)} module: ` + e);
		}
	}

	/**
	 * Returns block details from the blockchain
	 * @param {String} blockHashOrBlockNumber Block ID or its height to fetch
	 * @returns {Object}
	 * Used for income Tx security validation (deepExchangeValidator): timestamp
	 * getBlock doesn't provide confirmations (calc it from height)
	 */
	 getBlock(blockHashOrBlockNumber) {
		return new Promise(resolve => {
			eth.getBlock(blockHashOrBlockNumber, false, (error, block) => {
				if (error || !block) {
					log.warn(`Unable to get block ${blockHashOrBlockNumber} info in getBlock() of ${utils.getModuleName(module.id)} module. ` + error);
					resolve(null);
				} else {
					// log.log(`Block info: block ${block.hash} forged at ${block.number} blockchain height on ${utils.formatDate(block.timestamp*1000).YYYY_MM_DD_hh_mm} (${block.timestamp}).`);
					resolve({
						height: block.number,
						blockId: block.hash,
						hash: block.hash,
						timestamp: block.timestamp * 1000
					});
				}
			}).catch(e => {
				log.warn(`Error while getting block ${blockHashOrBlockNumber} info in getBlock() of ${utils.getModuleName(module.id)} module. ` + e);
			});
		});
	}

	/**
	 * Returns Tx receipt and some details from the blockchain
	 * @param {String} hash Tx ID to fetch
	 * @returns {Object}
	 * Used for income Tx security validation (deepExchangeValidator): senderId, recipientId, amount (ERC20 only)
	 * Used for checking income Tx status (confirmationsCounter), exchange and send-back Tx status (sentTxChecker): status, confirmations || height
	 * Not used, additional info: hash (already known), blockId, logs, gasUsed, contract (ERC20)
	 * getTransactionReceipt doesn't provide amount (ETH), input (ERC20), gasPrice, nonce, confirmations (calc it from height)
	 */
	getTransactionReceipt(hash) {
		return new Promise(resolve => {
			eth.getTransactionReceipt(hash, (error, receipt) => {
				if (error || !receipt) {
					log.warn(`Unable to get Tx ${hash} receipt in getTransactionReceipt() of ${utils.getModuleName(module.id)} module. It's expected, if the Tx is new. ` + error);
					resolve(null);
				} else {
					let tx = {
						status: receipt.status,
						height: receipt.blockNumber,
						blockId: receipt.blockHash,
						hash: receipt.transactionHash,
						senderId: receipt.from,
						recipientId: receipt.to,
						confirmations: undefined, // we need to calc confirmations from height
						gasUsed: receipt.gasUsed // to calculate Tx fee
					}
					if (receipt.logs && receipt.logs[0] && receipt.logs[0].topics[2] && receipt.logs[0].topics[2].length > 20) {
						// it is a ERC20 token transfer
						tx.logs0 = receipt.logs[0];
						tx.recipientId = receipt.logs[0].topics[2].replace('000000000000000000000000', '');
						tx.contract = receipt.to;
						tx.amount = +receipt.logs[0].data; // from like '0x000...069cd3a5c0' to 28400920000
						let token = this.getErc20token(tx.contract);
						if (token) { // in token's decimals
							tx.amount = tx.amount / token.sat;
						} else {
							tx.isAmountPlain = true;
						}
					}
					// log.log(`Tx receipt: ${this.formTxMessage(tx)}.`);
					resolve(tx);
				}
			}).catch(e => {
				log.warn(`Error while getting Tx ${hash} receipt in getTransactionReceipt() of ${utils.getModuleName(module.id)} module. It's expected, if the Tx is new. ` + e);
			});
		});
	}

	/**
	 * Returns Tx details from the blockchain
	 * @param {String} hash Tx ID to fetch
	 * @returns {Object}
	 * Used for income Tx security validation (deepExchangeValidator): senderId, recipientId, amount
	 * Used for checking income Tx status (confirmationsCounter), exchange and send-back Tx status (sentTxChecker): confirmations || height
	 * Not used, additional info: hash (already known), blockId, gasPrice, contract (ERC20), nonce
	 * getTransactionReceipt doesn't provide status, gasUsed, confirmations (calc it from height)
	 */	
	getTransactionDetails(hash) {
		return new Promise((resolve) => {
			eth.getTransaction(hash, (error, txDetails) => {
				if (error || !txDetails) {
					log.warn(`Unable to get Tx ${hash} details in getTransactionDetails() of ${utils.getModuleName(module.id)} module. It's expected, if the Tx is new. ` + error);
					resolve(null);
				} else {
					let tx = {
						height: txDetails.blockNumber,
						blockId: txDetails.blockHash,
						hash: txDetails.hash,
						senderId: txDetails.from,
						recipientId: txDetails.to,
						confirmations: undefined, // we need to calc confirmations from height
						amount: +ethUtils.fromWei(String(txDetails.value)), // in ETH
						gasPrice: txDetails.gasPrice, // to calculate Tx fee
						nonce: txDetails.nonce
					};
					if (txDetails.input && txDetails.input.length === 138) {
						// it is a ERC20 token transfer
						// Correct contract transfer transaction represents '0x' + 4 bytes 'a9059cbb' + 32 bytes (64 chars) for contract address and 32 bytes for its value
						// 0xa9059cbb000000000000000000000000651a2d48211428be3ffecea7a9aceeef250b019f000000000000000000000000000000000000000000000000000000069cd3a5c0
						tx.input = txDetails.input;
						tx.recipientId = '0x' + txDetails.input.substring(10, 74).replace('000000000000000000000000', '');
						tx.contract = txDetails.to;
						tx.amount = +('0x' + txDetails.input.substring(74));
						let token = this.getErc20token(tx.contract);
						if (token) { // in token's decimals
							tx.amount = tx.amount / token.sat;
						} else {
							tx.isAmountPlain = true;
						}
					}
					// log.log(`Tx details: ${this.formTxMessage(tx)}.`);
					resolve(tx);
				}
			}).catch(e => {
				log.warn(`Error while getting Tx ${hash} details in getTransactionDetails() of ${utils.getModuleName(module.id)} module. It's expected, if the Tx is new. ` + e);
			});
		});
	}

	/**
	 * Integrates getTransactionReceipt(), getTransactionDetails(), getBlock() to fetch all available info from the blockchain
	 * @param {String} hash Tx ID to fetch
	 * @returns {Object}
	 */	
	async getTransaction(hash) {
		let txReceipt, txDetails, blockInfo, tx;
		txReceipt = await this.getTransactionReceipt(hash);
		if (txReceipt) {
			tx = txReceipt;
			txDetails = await this.getTransactionDetails(hash);
			if (txDetails) {
				tx = {...tx, ...txDetails};
				if (tx.blockId) {
					blockInfo = await this.getBlock(tx.blockId);
					if (blockInfo) {
						tx.timestamp = blockInfo.timestamp;
					}
				}
			}
		}
		if (tx) {
			log.log(`getTransaction(): ${this.formTxMessage(tx)}.`);
		} else {
			log.warn(`Unable to get Tx ${hash} in getTransaction() of ${utils.getModuleName(module.id)} module. It's expected, if the Tx is new.`);
		}
		return tx
	}

	async send(params) {
		try {

			const txParams = {
				// nonce: this.currentNonce++, // set as default
				// gasPrice: this.gasPrice, // set as default
				gas: Math.round(this.gasLimit * this.reliabilityCoef),
			};
			if (this.contract) {
				txParams.value = '0x0';
				txParams.to = this.erc20model.sc,
				txParams.data = this.contract.methods.transfer(params.address, this.toSat(params.value)).encodeABI();
			} else {
				txParams.value = this.toSat(params.value);
				txParams.to = params.address;
			}

			return new Promise(resolve => {
				eth.sendTransaction(txParams)
					.on('transactionHash', (hash) => {
						log.log(`Formed Tx to send ${params.value} ${this.token} to ${params.address}, Tx hash: ${hash}.`);
						resolve({
							success: true,
							hash
						});
					})
					.on('receipt', (receipt) => {
						log.log(`Got Tx ${receipt.transactionHash} receipt, ${params.value} ${this.token} to ${params.address}: ${this.formTxMessage(receipt)}.`);						
					})
					.on('confirmation', (confirmationNumber, receipt) => {
						if (confirmationNumber === 0) {
							log.log(`Got the first confirmation for ${receipt.transactionHash} Tx, ${params.value} ${this.token} to ${params.address}. Tx receipt: ${this.formTxMessage(receipt)}.`);						
						}
					})
					.on('error', (error, receipt) => {  // If out of gas error, the second parameter is the receipt
						if (receipt && receipt.transactionHash) {
							if (!error.toString().includes('Failed to check for transaction receipt')) { // Known bug that after Tx sent successfully, this error occurred anyway https://github.com/ethereum/web3.js/issues/3145
								log.error(`Unable to send ${receipt.transactionHash} Tx, ${params.value} ${this.token} to ${params.address}. Tx receipt: ${this.formTxMessage(receipt)}. ` + error);
								} else {
									log.error(`Unable to send ${params.value} ${this.token} to ${params.address}. No Tx receipt. ` + error);						
								}
								resolve({
									success: false,
									error: error.toString()
								});
							}
					}).catch(e => {
						if (!e.toString().includes('Failed to check for transaction receipt')) { // Known bug that after Tx sent successfully, this error occurred anyway https://github.com/ethereum/web3.js/issues/3145
							log.error(`(Exception) Failed to send ${params.value} ${this.token} to ${params.address}. ` + e);						
							resolve({
								success: false,
								error: e.toString()
							});
						}
					});
			});

		} catch (e) {
			log.warn(`Error while sending ${params.value} ${this.token} to ${params.address} in send() of ${utils.getModuleName(module.id)} module. Error: ` + e);
			return {
				success: false,
				error: e.toString()
			}
		}
	}

	getErc20token(contract) {
		let token;
		Object.keys(erc20models).forEach((t) => {
			if (utils.isStringEqualCI(erc20models[t].sc, contract)) {
				token = erc20models[t]
			}
		});
		return token;
	}

	formTxMessage(tx) {
		let token = this.getErc20token(tx.contract);
		if (token) {
			token = token.token;
		} else {
			token = tx.contract ? tx.contract : 'ETH';
		}
		let status = tx.status ? ' is accepted' : tx.status === false ? ' is FAILED' : ''; 
		let amount = tx.amount ? ` for ${tx.amount} ${tx.isAmountPlain ? '(plain contract value)' : token}` : '';
		let height = tx.height ? ` ${status ? 'and ' : ''}included at ${tx.height} blockchain height` : '';
		let time = tx.timestamp ? ` (${utils.formatDate(tx.timestamp).YYYY_MM_DD_hh_mm} — ${tx.timestamp})` : '';
		let hash = tx.hash;
		let gasUsed = tx.gasUsed ? `, ${tx.gasUsed} gas used` : '';
		let gasPrice = tx.gasPrice ? `, gas price is ${tx.gasPrice}` : '';
		let fee;
		if (tx.gasUsed && tx.gasPrice) {
			fee = +ethUtils.fromWei(String(+tx.gasUsed * +tx.gasPrice));
		}
		fee = fee ? `, ${fee} ETH fee` : '';
		let nonce = tx.nonce ? `, nonce — ${tx.nonce}` : '';
		let senderId = utils.isStringEqualCI(tx.senderId, this.account.address) ? 'Me' : tx.senderId;
		let recipientId = utils.isStringEqualCI(tx.recipientId, this.account.address) ? 'Me' : tx.recipientId;
		let contract = tx.contract ? ` via ${token} contract` : '';
		let message = `Tx ${hash}${amount} from ${senderId} to ${recipientId}${contract}${status}${height}${time}${gasUsed}${gasPrice}${fee}${nonce}`
		return message
	}

};

const abiArray = [{
	'constant': true,
	'inputs': [],
	'name': 'name',
	'outputs': [{
		'name': '',
		'type': 'string'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': false,
	'inputs': [{
		'name': '_spender',
		'type': 'address'
	}, {
		'name': '_value',
		'type': 'uint256'
	}],
	'name': 'approve',
	'outputs': [{
		'name': '',
		'type': 'bool'
	}],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [],
	'name': 'totalSupply',
	'outputs': [{
		'name': '',
		'type': 'uint256'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': false,
	'inputs': [{
		'name': '_from',
		'type': 'address'
	}, {
		'name': '_to',
		'type': 'address'
	}, {
		'name': '_value',
		'type': 'uint256'
	}],
	'name': 'transferFrom',
	'outputs': [{
		'name': '',
		'type': 'bool'
	}],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [],
	'name': 'INITIAL_SUPPLY',
	'outputs': [{
		'name': '',
		'type': 'uint256'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [],
	'name': 'decimals',
	'outputs': [{
		'name': '',
		'type': 'uint8'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': false,
	'inputs': [{
		'name': '_spender',
		'type': 'address'
	}, {
		'name': '_subtractedValue',
		'type': 'uint256'
	}],
	'name': 'decreaseApproval',
	'outputs': [{
		'name': '',
		'type': 'bool'
	}],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [{
		'name': '_owner',
		'type': 'address'
	}],
	'name': 'balanceOf',
	'outputs': [{
		'name': 'balance',
		'type': 'uint256'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [],
	'name': 'symbol',
	'outputs': [{
		'name': '',
		'type': 'string'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': false,
	'inputs': [{
		'name': '_to',
		'type': 'address'
	}, {
		'name': '_value',
		'type': 'uint256'
	}],
	'name': 'transfer',
	'outputs': [{
		'name': '',
		'type': 'bool'
	}],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'function'
}, {
	'constant': false,
	'inputs': [{
		'name': '_spender',
		'type': 'address'
	}, {
		'name': '_addedValue',
		'type': 'uint256'
	}],
	'name': 'increaseApproval',
	'outputs': [{
		'name': '',
		'type': 'bool'
	}],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [{
		'name': '_owner',
		'type': 'address'
	}, {
		'name': '_spender',
		'type': 'address'
	}],
	'name': 'allowance',
	'outputs': [{
		'name': '',
		'type': 'uint256'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'inputs': [],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'constructor'
}, {
	'anonymous': false,
	'inputs': [{
		'indexed': true,
		'name': 'owner',
		'type': 'address'
	}, {
		'indexed': true,
		'name': 'spender',
		'type': 'address'
	}, {
		'indexed': false,
		'name': 'value',
		'type': 'uint256'
	}],
	'name': 'Approval',
	'type': 'event'
}, {
	'anonymous': false,
	'inputs': [{
		'indexed': true,
		'name': 'from',
		'type': 'address'
	}, {
		'indexed': true,
		'name': 'to',
		'type': 'address'
	}, {
		'indexed': false,
		'name': 'value',
		'type': 'uint256'
	}],
	'name': 'Transfer',
	'type': 'event'
}];
