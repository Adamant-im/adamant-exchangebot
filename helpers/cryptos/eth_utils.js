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
const reliabilityCoefEth = 1.3; // make sure exchanger's Tx will be accepted for ETH
const reliabilityCoefErc20 = 3.0; // make sure exchanger's Tx will be accepted for ERC20; 2.4 is not enough for BZ

const baseCoin = require('./baseCoin');

module.exports = class ethCoin extends baseCoin {
  gasPrice = '0'; // in wei, string
  gasLimit = 22000; // const base gas limit in wei

  constructor(token) {
    super();

    this.token = token;
    this.cache.balance = { lifetime: 10000 }; // in wei, string

    if (token === 'ETH') {
      this.reliabilityCoef = reliabilityCoefEth;
      this.cache.lastBlock = { lifetime: 10000 };
      this.account.keyPair = api.eth.keys(config.passPhrase);
      this.account.address = this.account.keyPair.address;
      this.account.privateKey = this.account.keyPair.privateKey;
      eth.accounts.wallet.add(this.account.privateKey);
      eth.defaultAccount = this.account.address;
      eth.defaultBlock = 'latest';

      this.decimals = 18;
      this.unit = 'ether';

      this.updateGasPrice().then(() => {
        log.log(`Estimate ${this.token} gas price: ${this.gasPrice ? this.fromSat(this.gasPrice).toFixed(9) + ' (' + ethUtils.fromWei(this.gasPrice, 'Gwei') + ' gwei)' : 'unable to calculate'}`);
        log.log(`Estimate ${this.token} Tx fee: ${this.FEE ? this.FEE.toFixed(constants.PRINT_DECIMALS) : 'unable to calculate'}`);
      });

      setInterval(() => {
        this.updateGasPrice();
      }, updateGasPriceInterval);
    } else {
      this.reliabilityCoef = reliabilityCoefErc20;
      this.reliabilityCoefFromEth = reliabilityCoefErc20 / reliabilityCoefEth;
      this.erc20model = erc20models[token];
      this.contract = new eth.Contract(abiArray, this.erc20model.sc, { from: this.account.address });

      const unitMap = ethUtils.unitMap;
      const multiplier = '1'.padEnd(this.erc20model.decimals + 1, '0');
      this.unit = Object.keys(unitMap).find((k) => unitMap[k] === multiplier);
      this.decimals = this.erc20model.decimals;

      if (!this.unit) {
        throw String(`No conversion unit found for ${this.token}, decimals: ${this.erc20model.decimals}. Check erc20_models.`);
      }
    }

    setTimeout(() => this.getBalance().then((balance) => log.log(`Initial ${this.token} balance: ${utils.isPositiveOrZeroNumber(balance) ? balance.toFixed(constants.PRINT_DECIMALS) : 'unable to receive'}`)), 1000);
  }

  /**
   * Returns estimate Tx fee in ETH for regular or contract Tx
   * @return {Number}
   */
  get FEE() {
    try {
      return +(+ethUtils.fromWei(String(+this.gasPrice * this.gasLimit)) * this.reliabilityCoef)
          .toFixed(constants.PRECISION_DECIMALS);
    } catch (e) {
      log.warn(`Error while calculating Tx fee for ${this.token} in FEE() of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Caches gas price in wei. For ETH only, ERC20 tokens don't call it.
   * @return {undefined} Nothing to return. Store this.gasPrice
   */
  updateGasPrice() {
    return new Promise((resolve) => {
      eth.getGasPrice().then((price) => {
        if (price) {
          this.gasPrice = price;
        } else {
          log.warn(`Failed to get Ether gas price in updateGasPrice() of ${utils.getModuleName(module.id)} module. Received value: ` + price);
        }
        resolve();
      }).catch((e) => {
        log.warn(`Error while getting Ether gas price in updateGasPrice() of ${utils.getModuleName(module.id)} module. Error: ` + e);
        resolve();
      });
    });
  }

  /**
   * Returns last block of Ethereum blockchain from cache, if it's up to date.
   * If not, makes an API request and updates cached data.
   * ERC20 tokens redirects to ETH instance.
   * @return {Object} or undefined, if unable to get block info
   */
  getLastBlock() {
    const cached = this.cache.getData('lastBlock', true);
    if (cached) {
      return cached;
    }
    return new Promise((resolve) => {
      eth.getBlock('latest').then((block) => {
        if (block) {
          this.cache.cacheData('lastBlock', block);
        } else {
          log.warn(`Failed to get last block in getLastBlock() of ${utils.getModuleName(module.id)} module. Received value: ` + block);
        }
        resolve(block);
      }).catch((e) => {
        log.warn(`Error while getting last block in getLastBlock() of ${utils.getModuleName(module.id)} module. Error: ` + e);
        resolve();
      });
    });
  }

  /**
   * Returns last block height of Ethereum blockchain.
   * ERC20 tokens redirects to ETH instance.
   * @return {Number} or undefined, if unable to get block info
   */
  async getLastBlockHeight() {
    const block = await this.getLastBlock();
    return block ? block.number : undefined;
  }

  /**
   * Converts amount in sat to token
   * 15000000 -> 15 USDT
   * @param {String|Number} satValue Amount in sat
   * @return {Number} Amount in token
   */
  fromSat(satValue) {
    try {
      return +ethUtils.fromWei(String(satValue), this.unit);
    } catch (e) {
      log.warn(`Error while converting fromSat(${satValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Converts amount in token to sat/wei
   * 15.123456 USDT -> 15123456
   * 15.12345678 USDT -> 15123457
   * @param {String|Number} tokenValue Amount in token
   * @return {String} Amount in sat
   */
  toSat(tokenValue) {
    try {
      tokenValue = (+tokenValue).toFixed(this.decimals);
      return ethUtils.toWei(tokenValue, this.unit);
    } catch (e) {
      log.warn(`Error while converting toSat(${tokenValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Returns ETH or ERC20 balance from cache, if it's up to date. If not, makes an API request and updates cached data.
   * Cache stores balance in wei (string)
   * @return {Number} or outdated cached value, if unable to fetch data; it may be undefined also
   */
  async getBalance() {
    try {

      const cached = this.cache.getData('balance', true);
      if (cached) { // balance is a wei string
        return this.fromSat(cached);
      }
      let balance;
      if (this.contract) {
        balance = await this.contract.methods.balanceOf(this.account.address).call();
      } else {
        balance = await eth.getBalance(this.account.address);
      }
      if (balance !== undefined) {
        this.cache.cacheData('balance', balance);
        return this.fromSat(balance);
      } else {
        log.warn(`Failed to get balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module; returning outdated cached balance.`);
        return this.fromSat(this.cache.getData('balance', false));
      }

    } catch (e) {
      log.warn(`Error while getting balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Returns balance ETH or ERC20 balance from cache. It may be outdated.
   * @return {Number} cached value; it may be undefined
   */
  get balance() {
    try {
      return this.fromSat(this.cache.getData('balance', false));
    } catch (e) {
      log.warn(`Error while getting balance in balance() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
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
      log.warn(`Error setting balance in balance() for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  /**
   * Returns block details from the blockchain
   * @param {String} blockHashOrBlockNumber Block ID or its height to fetch
   * @return {Object}
   * Used for income Tx security validation (deepExchangeValidator): timestamp
   * getBlock doesn't provide confirmations (calc it from height)
   */
  getBlock(blockHashOrBlockNumber) {
    return new Promise((resolve) => {
      eth.getBlock(blockHashOrBlockNumber, false, (error, block) => {
        if (error || !block) {
          log.warn(`Unable to get block ${blockHashOrBlockNumber} info for ${this.token} in getBlock() of ${utils.getModuleName(module.id)} module. ` + error);
          resolve(null);
        } else {
          resolve({
            height: block.number,
            blockId: block.hash,
            hash: block.hash,
            timestamp: block.timestamp * 1000,
          });
        }
      }).catch((e) => {
        // Duplicate of error
      });
    });
  }

  /**
   * Returns Tx receipt and some details from the blockchain
   * Internal for eth_utils method
   * @param {String} hash Tx ID to fetch
   * @return {Object}
   * Used for income Tx security validation (deepExchangeValidator): senderId, recipientId, amount (ERC20 only)
   * Used for checking income Tx status (confirmationsCounter), exchange and send-back Tx status (sentTxChecker):
   * status, confirmations || height
   * Not used, additional info: hash (already known), blockId, logs, gasUsed, contract (ERC20)
   * getTransactionReceipt doesn't provide amount (ETH), input (ERC20), gasPrice, nonce, confirmations (calc it from height)
   */
  getTransactionReceipt(hash) {
    return new Promise((resolve) => {
      eth.getTransactionReceipt(hash, (error, receipt) => {
        if (error || !receipt) {
          log.warn(`Unable to get Tx ${hash} receipt for ${this.token} in getTransactionReceipt() of ${utils.getModuleName(module.id)} module. It's expected, if the Tx is new. ` + error);
          resolve(null);
        } else {
          resolve(this.formTxUsingReceiptOrEthTx(receipt));
        }
      }).catch((e) => {
        // Duplicate of error
      });
    });
  }

  /**
   * Returns Tx details from the blockchain
   * Internal for eth_utils method
   * @param {String} hash Tx ID to fetch
   * @return {Object}
   * Used for income Tx security validation (deepExchangeValidator): senderId, recipientId, amount
   * Used for checking income Tx status (confirmationsCounter), exchange and send-back Tx status (sentTxChecker):
   * confirmations || height
   * Not used, additional info: hash (already known), blockId, gasPrice, contract (ERC20), nonce
   * getTransactionReceipt doesn't provide status, gasUsed, confirmations (calc it from height)
   */
  getTransactionDetails(hash) {
    return new Promise((resolve) => {
      eth.getTransaction(hash, (error, txDetails) => {
        if (error || !txDetails) {
          log.warn(`Unable to get Tx ${hash} details for ${this.token} in getTransactionDetails() of ${utils.getModuleName(module.id)} module. It's expected, if the Tx is new. ` + error);
          resolve(null);
        } else {
          resolve(this.formTxUsingReceiptOrEthTx(txDetails));
        }
      }).catch((e) => {
        // Duplicate of error
      });
    });
  }

  /**
   * Integrates getTransactionReceipt(), getTransactionDetails(), getBlock() to fetch all available info from the blockchain
   * It's a common method for every crypto and used in other modules to get Tx info in Exchanger's format
   * @param {String} hash Tx ID to fetch
   * @return {Object}
   */
  async getTransaction(hash) {
    let txDetails; let blockInfo; let tx;

    const txReceipt = await this.getTransactionReceipt(hash);
    if (txReceipt) {
      tx = txReceipt;

      txDetails = await this.getTransactionDetails(hash);
      if (txDetails) {
        tx = { ...tx, ...txDetails };

        if (tx.blockId) {
          blockInfo = await this.getBlock(tx.blockId);
          if (blockInfo) {
            tx.timestamp = blockInfo.timestamp;
          }
        }
      }
    }

    if (tx) {
      log.log(`Checking getTransaction(): ${this.formTxMessage(tx)}.`);
    }

    return tx;
  }

  async send(params) {
    params.try = params.try || 1;
    const tryString = ` (try number ${params.try})`;

    const gas = Math.round(this.gasLimit * this.reliabilityCoef * params.try);

    try {
      const txParams = {
        // nonce: this.currentNonce++, // set as default
        // gasPrice: this.gasPrice, // (deprecated after London hardfork)
        // maxFeePerGas // set as default
        // maxPriorityFeePerGas // set as default
        gas,
      };

      if (this.contract) {
        txParams.value = '0x0';
        txParams.to = this.erc20model.sc;
        txParams.data = this.contract.methods.transfer(params.address, this.toSat(params.value)).encodeABI();
      } else {
        txParams.value = this.toSat(params.value);
        txParams.to = params.address;
      }

      return new Promise((resolve) => {
        eth.sendTransaction(txParams)
            .on('transactionHash', (hash) => {
              log.log(`Formed Tx to send ${params.value} ${this.token} to ${params.address} with gas limit of ${gas}${tryString}, Tx hash: ${hash}.`);
              resolve({
                success: true,
                hash,
              });
            })
            .on('receipt', (receipt) => {
              log.log(`Got Tx ${receipt.transactionHash} receipt, ${params.value} ${this.token} to ${params.address}: ${this.formTxMessage(this.formTxUsingReceiptOrEthTx(receipt))}.`);
            })
            .on('confirmation', (confirmationNumber, receipt) => {
              if (confirmationNumber === 0) {
                log.log(`Got the first confirmation for ${receipt.transactionHash} Tx, ${params.value} ${this.token} to ${params.address}. Tx receipt: ${this.formTxMessage(this.formTxUsingReceiptOrEthTx(receipt))}.`);
              }
            })
            .on('error', (e, receipt) => { // If out of gas error, the second parameter is the receipt
              if (!e.toString().includes('Failed to check for transaction receipt')) {
                // Known bug that after Tx sent successfully, this error occurred anyway https://github.com/ethereum/web3.js/issues/3145
                // With "web3-eth": "^1.6.0", still get it
                log.error(`Failed to send ${params.value} ${this.token} to ${params.address} with gas limit of ${gas}. ` + e);
                resolve({
                  success: false,
                  error: e.toString(),
                });
              }
            }).catch((e) => {
            // Duplicates on-error
            });
      });
    } catch (e) {
      log.warn(`Error while sending ${params.value} ${this.token} to ${params.address} with gas limit of ${gas}${tryString} in send() of ${utils.getModuleName(module.id)} module. Error: ` + e);

      return {
        success: false,
        error: e.toString(),
      };
    }
  }

  getErc20token(contract) {
    let token;

    Object.keys(erc20models).forEach((t) => {
      if (utils.isStringEqualCI(erc20models[t].sc, contract)) {
        token = erc20models[t];
      }
    });

    return token;
  }

  /**
   * Builds tx info using Tx Receipt or Eth Tx info
   * @param {Object} receiptOrEthTx Tx Receipt or Eth Tx info
   * @return {String} Tx info in Exchanger's format
   */
  formTxUsingReceiptOrEthTx(receiptOrEthTx) {
    const tx = {
      status: receiptOrEthTx.status, // receipt only
      height: receiptOrEthTx.blockNumber,
      blockId: receiptOrEthTx.blockHash,
      hash: receiptOrEthTx.transactionHash || receiptOrEthTx.hash, // differs for receipt and eth-tx
      senderId: receiptOrEthTx.from,
      recipientId: receiptOrEthTx.to,
      confirmations: undefined, // we calc confirmations from height in the checker module
      gasUsed: receiptOrEthTx.gasUsed, // to calculate Tx fee; receipt only
      gasPrice: receiptOrEthTx.gasPrice, // to calculate Tx fee; eth-tx only
      nonce: receiptOrEthTx.nonce, // eth-tx only
    };

    // An eth-tx includes value of ETH
    if (receiptOrEthTx.value) {
      tx.amount = this.fromSat(receiptOrEthTx.value);
    }

    // A receipt includes logs for ERC20 tokens
    if (receiptOrEthTx.logs?.[0]?.topics?.[2]?.length > 20) {
      // it is a ERC20 token transfer
      tx.logs0 = receiptOrEthTx.logs[0];
      tx.recipientId = receiptOrEthTx.logs[0].topics[2].replace('000000000000000000000000', '');
      tx.contract = receiptOrEthTx.to;
      tx.amount = +receiptOrEthTx.logs[0].data; // from like '0x000...069cd3a5c0' to 28400920000
      tx.amount = this.fromSat(tx.amount);
    }

    // An eth-tx includes input for ERC20 tokens
    if (receiptOrEthTx.input?.length === 138) {
      // it is a ERC20 token transfer
      // Correct contract transfer transaction represents '0x' + 4 bytes 'a9059cbb' +
      // + 32 bytes (64 chars) for contract address and 32 bytes for its value
      // 0xa9059cbb000000000000000000000000651a2d48211428be3ffecea7a9aceeef250b019f..
      // ..000000000000000000000000000000000000000000000000000000069cd3a5c0
      tx.input = receiptOrEthTx.input;
      tx.recipientId = '0x' + receiptOrEthTx.input.substring(10, 74).replace('000000000000000000000000', '');
      tx.contract = receiptOrEthTx.to;
      tx.amount = +('0x' + receiptOrEthTx.input.substring(74));
      tx.amount = this.fromSat(tx.amount);
    }

    // Remove undefined fields not to loose date when merging receipt and eth-tx
    Object.keys(tx).forEach((key) => tx[key] === undefined && delete tx[key]);

    return tx;
  }

  /**
   * Creates info string about Transaction
   * Sample: Tx 0xb831fc54b5113b9726d5b55dcfe531da6761e194b2d9ab2bafbde5f5dc93e549 for 100 USDT
   *  from 0xFbaC15584dc40A97942BD9720D2c4645736CC5d9 to Me via USDT contract is accepted
   *  and included at 17975212 blockchain height (2023-08-23 07:06 — 1692767195000), 46097 gas used,
   *  gas price is 13461439079, 0.000620531957224663 ETH fee, nonce — 3.
   * @param {Object} tx Tx info in Exchanger's format
   * @return {String}
   */
  formTxMessage(tx) {
    let token = this.getErc20token(tx.contract);

    if (token) {
      token = token.token;
    } else {
      token = tx.contract ? tx.contract : 'ETH';
    }

    const status = tx.status ? ' is accepted' : tx.status === false ? ' is FAILED' : '';
    const amount = tx.amount ? ` for ${tx.amount} ${token}` : '';
    const height = tx.height ? ` ${status ? 'and ' : ''}included at ${tx.height} blockchain height` : '';
    const time = tx.timestamp ? ` (${utils.formatDate(tx.timestamp).YYYY_MM_DD_hh_mm} — ${tx.timestamp})` : '';
    const hash = tx.hash;
    const gasUsed = tx.gasUsed ? `, ${tx.gasUsed} gas used` : '';
    const gasPrice = tx.gasPrice ? `, gas price is ${tx.gasPrice}` : '';

    let fee;
    if (tx.gasUsed && tx.gasPrice) {
      fee = +ethUtils.fromWei(String(+tx.gasUsed * +tx.gasPrice));
    }
    fee = fee ? `, ${fee} ETH fee` : '';

    const nonce = tx.nonce ? `, nonce — ${tx.nonce}` : '';
    const senderId = utils.isStringEqualCI(tx.senderId, this.account.address) ? 'Me' : tx.senderId;
    const recipientId = utils.isStringEqualCI(tx.recipientId, this.account.address) ? 'Me' : tx.recipientId;
    const contract = tx.contract ? ` via ${token} contract` : '';
    const message = `Tx ${hash}${amount} from ${senderId} to ${recipientId}${contract}${status}${height}${time}${gasUsed}${gasPrice}${fee}${nonce}`;

    return message;
  }
};

const abiArray = [{
  'constant': true,
  'inputs': [],
  'name': 'name',
  'outputs': [{
    'name': '',
    'type': 'string',
  }],
  'payable': false,
  'stateMutability': 'view',
  'type': 'function',
}, {
  'constant': false,
  'inputs': [{
    'name': '_spender',
    'type': 'address',
  }, {
    'name': '_value',
    'type': 'uint256',
  }],
  'name': 'approve',
  'outputs': [{
    'name': '',
    'type': 'bool',
  }],
  'payable': false,
  'stateMutability': 'nonpayable',
  'type': 'function',
}, {
  'constant': true,
  'inputs': [],
  'name': 'totalSupply',
  'outputs': [{
    'name': '',
    'type': 'uint256',
  }],
  'payable': false,
  'stateMutability': 'view',
  'type': 'function',
}, {
  'constant': false,
  'inputs': [{
    'name': '_from',
    'type': 'address',
  }, {
    'name': '_to',
    'type': 'address',
  }, {
    'name': '_value',
    'type': 'uint256',
  }],
  'name': 'transferFrom',
  'outputs': [{
    'name': '',
    'type': 'bool',
  }],
  'payable': false,
  'stateMutability': 'nonpayable',
  'type': 'function',
}, {
  'constant': true,
  'inputs': [],
  'name': 'INITIAL_SUPPLY',
  'outputs': [{
    'name': '',
    'type': 'uint256',
  }],
  'payable': false,
  'stateMutability': 'view',
  'type': 'function',
}, {
  'constant': true,
  'inputs': [],
  'name': 'decimals',
  'outputs': [{
    'name': '',
    'type': 'uint8',
  }],
  'payable': false,
  'stateMutability': 'view',
  'type': 'function',
}, {
  'constant': false,
  'inputs': [{
    'name': '_spender',
    'type': 'address',
  }, {
    'name': '_subtractedValue',
    'type': 'uint256',
  }],
  'name': 'decreaseApproval',
  'outputs': [{
    'name': '',
    'type': 'bool',
  }],
  'payable': false,
  'stateMutability': 'nonpayable',
  'type': 'function',
}, {
  'constant': true,
  'inputs': [{
    'name': '_owner',
    'type': 'address',
  }],
  'name': 'balanceOf',
  'outputs': [{
    'name': 'balance',
    'type': 'uint256',
  }],
  'payable': false,
  'stateMutability': 'view',
  'type': 'function',
}, {
  'constant': true,
  'inputs': [],
  'name': 'symbol',
  'outputs': [{
    'name': '',
    'type': 'string',
  }],
  'payable': false,
  'stateMutability': 'view',
  'type': 'function',
}, {
  'constant': false,
  'inputs': [{
    'name': '_to',
    'type': 'address',
  }, {
    'name': '_value',
    'type': 'uint256',
  }],
  'name': 'transfer',
  'outputs': [{
    'name': '',
    'type': 'bool',
  }],
  'payable': false,
  'stateMutability': 'nonpayable',
  'type': 'function',
}, {
  'constant': false,
  'inputs': [{
    'name': '_spender',
    'type': 'address',
  }, {
    'name': '_addedValue',
    'type': 'uint256',
  }],
  'name': 'increaseApproval',
  'outputs': [{
    'name': '',
    'type': 'bool',
  }],
  'payable': false,
  'stateMutability': 'nonpayable',
  'type': 'function',
}, {
  'constant': true,
  'inputs': [{
    'name': '_owner',
    'type': 'address',
  }, {
    'name': '_spender',
    'type': 'address',
  }],
  'name': 'allowance',
  'outputs': [{
    'name': '',
    'type': 'uint256',
  }],
  'payable': false,
  'stateMutability': 'view',
  'type': 'function',
}, {
  'inputs': [],
  'payable': false,
  'stateMutability': 'nonpayable',
  'type': 'constructor',
}, {
  'anonymous': false,
  'inputs': [{
    'indexed': true,
    'name': 'owner',
    'type': 'address',
  }, {
    'indexed': true,
    'name': 'spender',
    'type': 'address',
  }, {
    'indexed': false,
    'name': 'value',
    'type': 'uint256',
  }],
  'name': 'Approval',
  'type': 'event',
}, {
  'anonymous': false,
  'inputs': [{
    'indexed': true,
    'name': 'from',
    'type': 'address',
  }, {
    'indexed': true,
    'name': 'to',
    'type': 'address',
  }, {
    'indexed': false,
    'name': 'value',
    'type': 'uint256',
  }],
  'name': 'Transfer',
  'type': 'event',
}];
