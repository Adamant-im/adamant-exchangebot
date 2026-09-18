const ethers = require('ethers');
const { eth } = require('adamant-api/coins/eth');

const config = require('../../modules/configReader');
const log = require('../log');
const constants = require('../const');
const utils = require('../utils');
const erc20models = require('./erc20_models');
const BaseCoin = require('./baseCoin');

/** How often the gas price estimate is refreshed. */
const UPDATE_GAS_PRICE_INTERVAL = 60 * 1000;

/** Gas a plain transfer needs, before the reliability margin. */
const BASE_GAS_LIMIT = 22000;

/**
 * Margin applied to the estimated fee so a transfer is still accepted when the
 * gas price rises between quoting and sending.
 *
 * ERC-20 transfers need a larger margin than plain ETH transfers: a contract call
 * costs several times more gas, and how much depends on the token.
 */
const RELIABILITY_COEF_ETH = 1.3;
const RELIABILITY_COEF_ERC20 = 3.0;

/** Minimal ERC-20 interface — everything the bot reads, sends and decodes. */
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const erc20Interface = new ethers.Interface(ERC20_ABI);

/** The network the bot works on. ERC-20 contract addresses are mainnet addresses. */
const MAINNET = ethers.Network.from('mainnet');

/**
 * Builds a provider over the configured Ethereum nodes.
 *
 * With more than one node a `FallbackProvider` is used, so a single unreachable
 * node does not take Ethereum and every ERC-20 token down with it. A quorum of one
 * keeps the behaviour of the previous single-node setup: the first answer wins.
 *
 * @param {string[]} nodes Node URLs
 * @returns {ethers.AbstractProvider}
 */
function createProvider(nodes) {
  // The token contract addresses in `erc20_models.js` are Ethereum mainnet addresses,
  // so the network is known in advance. Declaring it skips the detection round trip and
  // stops ethers from printing a "failed to detect network" retry loop of its own when a
  // node is unreachable — a node failure then surfaces through this bot's logger instead.
  const providers = nodes.map((url) => new ethers.JsonRpcProvider(url, undefined, { staticNetwork: MAINNET }));

  if (providers.length === 1) {
    return providers[0];
  }

  return new ethers.FallbackProvider(
    providers.map((provider, index) => ({ provider, priority: index + 1, weight: 1 })),
    undefined,
    { quorum: 1 },
  );
}

/**
 * Ethereum adapter, and the base for the ERC-20 adapter.
 *
 * ETH and every ERC-20 token share one wallet, one provider and one gas price, so
 * the token adapters reuse the instance created for ETH rather than opening their
 * own connections.
 */
module.exports = class EthCoin extends BaseCoin {
  /**
   * @param {string} token Ticker, `ETH` or an ERC-20 token symbol
   * @param {EthCoin} [ethInstance] The ETH adapter, when constructing an ERC-20 token
   */
  constructor(token, ethInstance) {
    super();

    this.token = token;
    this.gasLimit = BASE_GAS_LIMIT;
    this.cache.balance = { lifetime: 10000 };

    if (ethInstance) {
      this.initToken(token, ethInstance);
    } else {
      this.initEther();
    }
  }

  /**
   * Sets up the ETH adapter: provider, wallet and gas price tracking.
   *
   * @private
   */
  initEther() {
    this.provider = createProvider(config.node_ETH);

    const keys = eth.keys(config.passPhrase);

    this.account.address = keys.address;
    this.account.privateKey = keys.privateKey;
    // ETH and every ERC-20 payout share one nonce sequence, so the signer must serialize
    // sends across the whole wallet rather than asking the provider for a fresh pending nonce
    // on every call.
    this.wallet = new ethers.NonceManager(new ethers.Wallet(keys.privateKey, this.provider));

    this.decimals = 18;
    this.reliabilityCoef = RELIABILITY_COEF_ETH;
    /** Gas price in wei, as a bigint. Refreshed by {@link startGasPriceUpdates}. */
    this.gasPrice = 0n;

    this.cache.lastBlock = { lifetime: 10000 };
  }

  /**
   * Sets up an ERC-20 adapter on top of the ETH adapter.
   *
   * @private
   * @param {string} token Token symbol
   * @param {EthCoin} ethInstance The ETH adapter
   * @throws {Error} When the token is not described in `erc20_models.js`
   */
  initToken(token, ethInstance) {
    const model = erc20models[token];

    if (!model) {
      throw new Error(`No ERC-20 model found for ${token}. Add it to helpers/cryptos/erc20_models.js.`);
    }

    this.ethInstance = ethInstance;
    this.provider = ethInstance.provider;
    this.wallet = ethInstance.wallet;
    this.account = ethInstance.account;

    this.model = model;
    this.decimals = model.decimals;
    this.reliabilityCoef = RELIABILITY_COEF_ERC20;
    this.contract = new ethers.Contract(model.sc, ERC20_ABI, this.wallet);
  }

  /**
   * Current gas price, in wei.
   *
   * ERC-20 tokens read it from the ETH adapter, which is the only one tracking it.
   *
   * @returns {bigint}
   */
  get currentGasPrice() {
    return this.ethInstance ? this.ethInstance.gasPrice : this.gasPrice;
  }

  /**
   * Estimated transfer fee, in ETH.
   *
   * The fee is always paid in ETH, including for ERC-20 transfers.
   *
   * @returns {number}
   */
  get FEE() {
    const gasPrice = this.currentGasPrice;

    if (!gasPrice) {
      return 0;
    }

    const feeInEther = Number(ethers.formatEther(gasPrice * BigInt(this.gasLimit)));

    return Number((feeInEther * this.reliabilityCoef).toFixed(constants.PRECISION_DECIMALS));
  }

  /**
   * Checks that an address is a valid Ethereum address.
   *
   * @param {string} address Address to validate
   * @returns {boolean}
   */
  isValidAddress(address) {
    return eth.isValidAddress(address);
  }

  /**
   * Converts the smallest unit to the base unit, for example wei to ETH, or 15000000 to 15 USDT.
   *
   * @param {bigint|string|number} value Amount in the smallest unit
   * @returns {number|undefined}
   */
  fromSat(value) {
    if (value === undefined || value === null) {
      return undefined;
    }

    try {
      return Number(ethers.formatUnits(BigInt(value), this.decimals));
    } catch (error) {
      log.warn(`Error while converting fromSat(${value}) for ${this.token}: ${error}`);

      return undefined;
    }
  }

  /**
   * Converts the base unit to the smallest unit, for example ETH to wei, or 15.123456 USDT to 15123456.
   *
   * @param {string|number} value Amount in the base unit
   * @returns {bigint|undefined}
   */
  toSat(value) {
    try {
      // Values beyond the token's precision cannot be represented on-chain;
      // fixing the string first keeps parseUnits from throwing on them.
      return ethers.parseUnits(Number(value).toFixed(this.decimals), this.decimals);
    } catch (error) {
      log.warn(`Error while converting toSat(${value}) for ${this.token}: ${error}`);

      return undefined;
    }
  }

  /**
   * Refreshes the cached gas price. Only the ETH adapter tracks it.
   *
   * @returns {Promise<void>}
   */
  async updateGasPrice() {
    try {
      const feeData = await this.provider.getFeeData();

      if (feeData.gasPrice) {
        this.gasPrice = feeData.gasPrice;
      } else {
        log.warn(`Failed to get the Ether gas price in updateGasPrice(). Received: ${feeData.gasPrice}`);
      }
    } catch (error) {
      log.warn(`Error while getting the Ether gas price in updateGasPrice(). ${error}`);
    }
  }

  /**
   * Starts refreshing the gas price in the background.
   *
   * @returns {Promise<void>}
   */
  async startGasPriceUpdates() {
    await this.updateGasPrice();

    log.log(
      `Estimated ${this.token} gas price: ${
        this.gasPrice ? `${ethers.formatUnits(this.gasPrice, 'gwei')} gwei` : 'unable to calculate'
      }`,
    );
    log.log(
      `Estimated ${this.token} Tx fee: ${this.FEE ? this.FEE.toFixed(constants.PRINT_DECIMALS) : 'unable to calculate'}`,
    );

    this.gasPriceInterval = setInterval(() => {
      void this.updateGasPrice();
    }, UPDATE_GAS_PRICE_INTERVAL);

    this.gasPriceInterval.unref?.();
  }

  /**
   * Returns the latest block, from cache when it is fresh.
   *
   * @returns {Promise<object|null|undefined>}
   */
  async getLastBlock() {
    if (this.ethInstance) {
      return this.ethInstance.getLastBlock();
    }

    const cached = this.cache.getData('lastBlock', true);

    if (cached) {
      return cached;
    }

    try {
      const block = await this.provider.getBlock('latest');

      if (block) {
        this.cache.cacheData('lastBlock', block);
      }

      return block;
    } catch (error) {
      log.warn(`Error while getting the last block in getLastBlock() for ${this.token}. ${error}`);

      return undefined;
    }
  }

  /**
   * Returns the latest block height.
   *
   * @returns {Promise<number|undefined>}
   */
  async getLastBlockHeight() {
    const block = await this.getLastBlock();

    return block ? block.number : undefined;
  }

  /**
   * Returns the bot's balance, from cache when it is fresh.
   *
   * @returns {Promise<number|undefined>} Balance in ETH or in the token; a stale cached value on failure
   */
  async getBalance() {
    const cached = this.cache.getData('balance', true);

    if (cached !== undefined) {
      return this.fromSat(cached);
    }

    try {
      const balance = this.contract
        ? await this.contract.balanceOf(this.account.address)
        : await this.provider.getBalance(this.account.address);

      // Cached as a decimal string: a bigint does not survive a JSON round trip.
      this.cache.cacheData('balance', balance.toString());

      return this.fromSat(balance);
    } catch (error) {
      log.warn(
        `Error while getting the balance in getBalance() for ${this.token} of ${utils.getModuleName(module.id)} module: ${error}`,
      );

      return this.fromSat(this.cache.getData('balance', false));
    }
  }

  /**
   * Returns the cached balance, which may be outdated.
   *
   * @returns {number|undefined}
   */
  get balance() {
    return this.fromSat(this.cache.getData('balance', false));
  }

  /**
   * Updates the cached balance.
   *
   * @param {number} value New balance, in ETH or in the token
   */
  set balance(value) {
    if (utils.isPositiveOrZeroNumber(value)) {
      this.cache.cacheData('balance', this.toSat(value)?.toString());
    }
  }

  /**
   * Looks up an ERC-20 model by contract address.
   *
   * @param {string} [contract] Contract address
   * @returns {{decimals: number, sc: string, token: string}|undefined}
   */
  getErc20token(contract) {
    if (!contract) {
      return undefined;
    }

    return Object.values(erc20models).find((model) => utils.isStringEqualCI(model.sc, contract));
  }

  /**
   * Fetches a transaction, its receipt and its block, and maps them to the bot's common shape.
   *
   * The receipt carries the success status and the gas actually used; the transaction
   * carries the value, the calldata and the nonce; the block carries the timestamp.
   *
   * @param {string} hash Transaction hash
   * @returns {Promise<object|undefined>} Transaction in the bot's common shape, or `undefined` when it is not found
   */
  async getTransaction(hash) {
    let receipt;
    let tx;

    try {
      [receipt, tx] = await Promise.all([
        this.provider.getTransactionReceipt(hash),
        this.provider.getTransaction(hash),
      ]);
    } catch (error) {
      log.warn(`Unable to get Tx ${hash} for ${this.token}. This is expected while the Tx is new. ${error}`);

      return undefined;
    }

    if (!receipt && !tx) {
      return undefined;
    }

    const formedTx = this.formTx(receipt, tx);

    if (formedTx.blockId) {
      try {
        const block = await this.provider.getBlock(formedTx.blockId);

        if (block) {
          formedTx.timestamp = block.timestamp * 1000;
        }
      } catch (error) {
        log.warn(`Unable to get block ${formedTx.blockId} for ${this.token}. ${error}`);
      }
    }

    log.log(`${this.token} Tx status: ${this.formTxMessage(formedTx)}.`);

    return formedTx;
  }

  /**
   * Merges a receipt and a transaction into the bot's common shape.
   *
   * An ERC-20 transfer is recognized from the `Transfer` event in the receipt, and
   * — when the receipt is not available yet — from the transaction's calldata. The
   * amount is converted with the decimals of the token that was actually moved,
   * which is not necessarily this adapter's token.
   *
   * @param {object|null} receipt Transaction receipt
   * @param {object|null} tx Transaction
   * @returns {object} Transaction in the bot's common shape
   */
  formTx(receipt, tx) {
    const formed = {
      hash: receipt?.hash ?? tx?.hash,
      height: receipt?.blockNumber ?? tx?.blockNumber ?? undefined,
      blockId: receipt?.blockHash ?? tx?.blockHash ?? undefined,
      senderId: receipt?.from ?? tx?.from,
      recipientId: receipt?.to ?? tx?.to,
      // Confirmations are derived from the height by the checker modules.
      confirmations: undefined,
      gasUsed: receipt ? Number(receipt.gasUsed) : undefined,
      gasPrice: receipt?.gasPrice ?? tx?.gasPrice,
      nonce: tx?.nonce,
    };

    if (receipt?.status !== null && receipt?.status !== undefined) {
      formed.status = receipt.status === 1;
    }

    if (tx?.value !== undefined && tx.value !== 0n) {
      formed.amount = Number(ethers.formatEther(tx.value));
    }

    const transfer = this.parseErc20Transfer(receipt, tx);

    if (transfer) {
      formed.contract = transfer.contract;
      formed.recipientId = transfer.to;
      formed.senderId = transfer.from ?? formed.senderId;
      formed.amount = transfer.amount;
    }

    for (const key of Object.keys(formed)) {
      if (formed[key] === undefined) {
        delete formed[key];
      }
    }

    return formed;
  }

  /**
   * Extracts an ERC-20 transfer from a receipt or a transaction.
   *
   * @private
   * @param {object|null} receipt Transaction receipt
   * @param {object|null} tx Transaction
   * @returns {{contract: string, from?: string, to: string, amount: number}|undefined}
   */
  parseErc20Transfer(receipt, tx) {
    for (const logEntry of receipt?.logs ?? []) {
      const model = this.getErc20token(logEntry.address);

      if (!model) {
        continue;
      }

      let parsed;

      try {
        parsed = erc20Interface.parseLog({ topics: [...logEntry.topics], data: logEntry.data });
      } catch {
        // Not an ERC-20 event the bot knows; other logs in the same receipt may still match.
        continue;
      }

      if (parsed?.name === 'Transfer') {
        return {
          contract: logEntry.address,
          from: parsed.args.from,
          to: parsed.args.to,
          amount: Number(ethers.formatUnits(parsed.args.value, model.decimals)),
        };
      }
    }

    // No receipt yet: fall back to the calldata of a pending contract call.
    const model = this.getErc20token(tx?.to);

    if (!model || !tx?.data || tx.data === '0x') {
      return undefined;
    }

    try {
      const parsed = erc20Interface.parseTransaction({ data: tx.data });

      if (parsed?.name === 'transfer') {
        return {
          contract: tx.to,
          to: parsed.args[0],
          amount: Number(ethers.formatUnits(parsed.args[1], model.decimals)),
        };
      }
    } catch {
      // The call is not an ERC-20 transfer.
    }

    return undefined;
  }

  /**
   * Sends ETH or an ERC-20 token.
   *
   * Resolves as soon as the transaction is broadcast and its hash is known; the
   * result is checked later by `sentTxChecker`, which is what lets a payout survive
   * a restart.
   *
   * @param {object} params Transfer parameters
   * @param {string} params.address Recipient's address
   * @param {number} params.value Amount, in ETH or in the token
   * @param {number} [params.try] Attempt number; each retry raises the gas limit
   * @returns {Promise<{success: boolean, hash?: string, error?: string}>}
   */
  async send(params) {
    const { address, value } = params;
    const attempt = params.try || 1;
    const attemptInfo = ` (attempt ${attempt})`;
    const gasLimit = Math.round(this.gasLimit * this.reliabilityCoef * attempt);

    if (!this.isValidAddress(address)) {
      const error = `'${address}' is not a valid Ethereum address`;

      log.error(`Refusing to send ${value} ${this.token}: ${error}.`);

      return { success: false, error };
    }

    const amount = this.toSat(value);

    if (amount === undefined) {
      const error = `unable to convert ${value} ${this.token} to the token's smallest unit`;

      log.error(`Refusing to send ${value} ${this.token}: ${error}.`);

      return { success: false, error };
    }

    try {
      const tx = this.contract
        ? await this.contract.transfer(address, amount, { gasLimit })
        : await this.wallet.sendTransaction({ to: address, value: amount, gasLimit });

      log.log(
        `Sent a Tx to transfer ${value} ${this.token} to ${address} with a gas limit of ${gasLimit}${attemptInfo}, Tx hash: ${tx.hash}.`,
      );

      return { success: true, hash: tx.hash };
    } catch (error) {
      // ethers throws both for a rejected transaction and for a transport failure after
      // the transaction was submitted, and the two are not reliably distinguishable. The
      // outcome is therefore unknown, and the caller must not retry on its own.
      log.error(
        `Failed to send ${value} ${this.token} to ${address} with a gas limit of ${gasLimit}${attemptInfo}. ${error}`,
      );

      return { success: false, isAmbiguous: true, error: error.toString() };
    }
  }

  /**
   * Builds a human-readable one-line description of a transaction.
   *
   * @param {object} tx Transaction in the bot's common shape
   * @returns {string}
   */
  formTxMessage(tx) {
    const model = this.getErc20token(tx.contract);
    const token = model ? model.token : (tx.contract ?? 'ETH');

    const status = tx.status ? ' is accepted' : tx.status === false ? ' has FAILED' : '';
    const amount = tx.amount ? ` for ${tx.amount} ${token}` : '';
    const height = tx.height ? ` ${status ? 'and ' : ''}included at ${tx.height} blockchain height` : '';
    const time = tx.timestamp ? ` (${utils.formatDate(tx.timestamp).YYYY_MM_DD_hh_mm} — ${tx.timestamp})` : '';
    const gasUsed = tx.gasUsed ? `, ${tx.gasUsed} gas used` : '';
    const gasPrice = tx.gasPrice ? `, gas price is ${tx.gasPrice}` : '';
    const nonce = tx.nonce ? `, nonce — ${tx.nonce}` : '';
    const contract = tx.contract ? ` via the ${token} contract` : '';
    const senderId = utils.isStringEqualCI(tx.senderId, this.account.address) ? 'Me' : tx.senderId;
    const recipientId = utils.isStringEqualCI(tx.recipientId, this.account.address) ? 'Me' : tx.recipientId;

    let fee = '';

    if (tx.gasUsed && tx.gasPrice) {
      fee = `, ${ethers.formatEther(BigInt(tx.gasUsed) * BigInt(tx.gasPrice))} ETH fee`;
    }

    return `Tx ${tx.hash}${amount} from ${senderId} to ${recipientId}${contract}${status}${height}${time}${gasUsed}${gasPrice}${fee}${nonce}`;
  }

  /**
   * Logs the balance the bot starts with.
   *
   * @returns {Promise<void>}
   */
  async logInitialState() {
    const balance = await this.getBalance();

    log.log(
      `Initial ${this.token} balance: ${
        utils.isPositiveOrZeroNumber(balance) ? balance.toFixed(constants.PRINT_DECIMALS) : 'unable to receive'
      }`,
    );
  }
};
