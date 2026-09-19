const bitcoin = require('bitcoinjs-lib');

const log = require('../log');
const constants = require('../const');
const utils = require('../utils');
const BaseCoin = require('./baseCoin');

/**
 * Shared behaviour of the UTXO coins: Bitcoin, Dash and Dogecoin.
 *
 * Transfers are built as PSBTs and signed locally — `bitcoinjs-lib` removed the
 * old `TransactionBuilder` in version 6. Every input the bot spends is a P2PKH
 * output, and PSBT requires the full previous transaction for such an input, so
 * each adapter's {@link getUnspents} must return the raw hex alongside the UTXO.
 *
 * @abstract
 */
module.exports = class BtcBaseCoin extends BaseCoin {
  /**
   * @param {string} token Ticker, for example `BTC`
   * @param {object} coinHelper Coin helper from `adamant-api/coins/*`
   * @param {string} passPhrase ADAMANT passphrase the wallet is derived from
   */
  constructor(token, coinHelper, passPhrase) {
    super();

    this.token = token;
    this.coinHelper = coinHelper;

    const keys = coinHelper.keys(passPhrase);

    this.account.keys = keys;
    this.account.network = keys.network;
    this.account.keyPair = keys.keyPair;
    this.account.address = keys.address;
    this.account.privateKey = keys.privateKey;
  }

  /**
   * Coin decimals.
   *
   * @abstract
   * @returns {number}
   */
  get decimals() {
    return 8;
  }

  /**
   * Multiplier between the coin's base unit and its smallest unit.
   *
   * @returns {number}
   */
  get multiplier() {
    return Math.pow(10, this.decimals);
  }

  /**
   * Smallest output value the network relays, in the coin's smallest unit.
   *
   * Change below this value cannot be spent and would make the transaction
   * non-standard, so it is dropped and paid to the miner instead.
   *
   * @abstract
   * @returns {number}
   */
  get dustThreshold() {
    return 0;
  }

  /**
   * Upper bound on the fee rate `bitcoinjs-lib` accepts when extracting a transaction,
   * in the coin's smallest unit per virtual byte.
   *
   * The library refuses to extract a transaction that pays an implausibly high fee.
   * That safety net is worth keeping, but it has to be calibrated per coin: Dogecoin's
   * fixed one-DOGE fee on a small transfer is a fee rate the Bitcoin default rejects.
   *
   * @returns {number}
   */
  get maximumFeeRate() {
    return 5000;
  }

  /**
   * Transfer fee, in the coin's base unit.
   *
   * @abstract
   * @returns {number}
   */
  get FEE() {
    return 0;
  }

  /**
   * The bot's wallet address for this coin.
   *
   * @returns {string}
   */
  get address() {
    return this.account.address;
  }

  /**
   * Checks that an address belongs to this coin's network.
   *
   * @param {string} address Address to validate
   * @returns {boolean}
   */
  isValidAddress(address) {
    return this.coinHelper.isValidAddress(address);
  }

  /**
   * Converts the coin's smallest unit to its base unit, for example satoshi to BTC.
   *
   * @param {string|number} satValue Amount in the smallest unit
   * @returns {number|undefined} Amount in the base unit, or `undefined` for a non-numeric input
   */
  fromSat(satValue) {
    // `Number(null)` and `Number('')` are 0, which would turn a missing balance into
    // a real one. Reject those before converting.
    if (satValue === null || satValue === undefined || satValue === '') {
      return undefined;
    }

    const amount = Number(satValue);

    if (!Number.isFinite(amount)) {
      return undefined;
    }

    return Number((amount / this.multiplier).toFixed(this.decimals));
  }

  /**
   * Converts the coin's base unit to its smallest unit, for example BTC to satoshi.
   *
   * @param {string|number} tokenValue Amount in the base unit
   * @returns {number|undefined} Amount in the smallest unit, or `undefined` for a non-numeric input
   */
  toSat(tokenValue) {
    if (tokenValue === null || tokenValue === undefined || tokenValue === '') {
      return undefined;
    }

    const amount = Number(tokenValue);

    if (!Number.isFinite(amount)) {
      return undefined;
    }

    // Round before truncating: 0.1 * 1e8 is 10000000.000000002 in binary floating point,
    // and a bare Math.floor() would silently lose a satoshi on values like that.
    return Math.floor(Number((amount * this.multiplier).toFixed(0)));
  }

  /**
   * Returns the last block, from cache when it is fresh.
   *
   * @abstract
   * @returns {Promise<*>} Block info, or `undefined` when it could not be fetched
   */
  async getLastBlock() {
    return undefined;
  }

  /**
   * Returns the last block height.
   *
   * @returns {Promise<number|undefined>}
   */
  async getLastBlockHeight() {
    const block = await this.getLastBlock();

    return utils.isPositiveNumber(block) ? block : undefined;
  }

  /**
   * Returns the bot's balance, from cache when it is fresh.
   *
   * @abstract
   * @returns {Promise<number|undefined>} Balance in the coin's base unit
   */
  async getBalance() {
    return undefined;
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
   * @param {number} value New balance, in the coin's base unit
   */
  set balance(value) {
    if (utils.isPositiveOrZeroNumber(value)) {
      this.cache.cacheData('balance', this.toSat(value));
    }
  }

  /**
   * Fetches a transaction and maps it to the bot's common shape.
   *
   * @abstract
   * @param {string} _txid Transaction ID
   * @returns {Promise<object|undefined>}
   */
  async getTransaction(_txid) {
    return undefined;
  }

  /**
   * Returns the bot's unspent outputs, each with the raw hex of the transaction that created it.
   *
   * @abstract
   * @returns {Promise<Array<{txid: string, vout: number, amount: number, hex: string}>|undefined>}
   */
  async getUnspents() {
    return undefined;
  }

  /**
   * Broadcasts a signed transaction.
   *
   * @abstract
   * @param {string} _txHex Raw transaction, as a hex string
   * @returns {Promise<string|undefined>} Transaction ID, or `undefined` when the broadcast failed
   */
  async sendTransaction(_txHex) {
    return undefined;
  }

  /**
   * Builds and signs a transfer.
   *
   * Inputs are added until they cover the amount plus the fee. Anything left over
   * goes back to the bot's own address as change — an unspent output that is not
   * claimed by an output of the transaction is paid to the miner.
   *
   * @param {string} address Recipient's address
   * @param {number} amount Amount to send, in the coin's base unit
   * @param {Array<{txid: string, vout: number, amount: number, hex: string}>} unspents Available UTXOs
   * @param {number} fee Fee to pay, in the coin's base unit
   * @returns {string} Signed transaction, as a hex string
   * @throws {Error} When the UTXOs cannot cover the transfer or an input has no raw transaction
   */
  buildTransaction(address, amount, unspents, fee) {
    const amountInSat = this.toSat(amount);
    const feeInSat = this.toSat(fee);
    const target = amountInSat + feeInSat;

    const psbt = new bitcoin.Psbt({
      network: this.account.network,
      maximumFeeRate: this.maximumFeeRate,
    });

    psbt.setVersion(1);

    let collected = 0;

    for (const unspent of unspents) {
      if (collected >= target) {
        break;
      }

      if (!unspent.hex) {
        throw new Error(`No raw transaction for the unspent output ${unspent.txid}:${unspent.vout}`);
      }

      psbt.addInput({
        hash: unspent.txid,
        index: unspent.vout,
        nonWitnessUtxo: Buffer.from(unspent.hex, 'hex'),
      });

      collected += Math.floor(unspent.amount);
    }

    if (collected < target) {
      throw new Error(
        `Not enough unspent outputs to send ${amount} ${this.token} with a ${fee} ${this.token} fee: ` +
          `collected ${this.fromSat(collected)} ${this.token} of ${this.fromSat(target)} ${this.token}`,
      );
    }

    psbt.addOutput({
      script: bitcoin.address.toOutputScript(address, this.account.network),
      value: BigInt(amountInSat),
    });

    const change = collected - target;

    // Change below the dust threshold cannot be spent, and an output that small makes
    // the transaction non-standard. Leaving it out pays it to the miner instead.
    if (change > this.dustThreshold) {
      psbt.addOutput({
        script: bitcoin.address.toOutputScript(this.address, this.account.network),
        value: BigInt(change),
      });
    }

    psbt.signAllInputs(this.account.keyPair);
    psbt.finalizeAllInputs();

    return psbt.extractTransaction().toHex();
  }

  /**
   * Builds a transfer and returns it with its transaction ID.
   *
   * @param {string} address Recipient's address
   * @param {number} amount Amount to send, in the coin's base unit
   * @param {number} fee Fee to pay, in the coin's base unit
   * @returns {Promise<{hex: string, txid: string}>}
   * @throws {Error} When the UTXOs cannot be fetched or cannot cover the transfer
   */
  async createTransaction(address, amount, fee) {
    const unspents = await this.getUnspents();

    if (!unspents?.length) {
      throw new Error(`No unspent outputs retrieved for ${this.token}`);
    }

    const hex = this.buildTransaction(address, amount, unspents, fee);
    const txid = bitcoin.Transaction.fromHex(hex).getId();

    return { hex, txid };
  }

  /**
   * Builds, signs and broadcasts a transfer.
   *
   * @param {object} params Transfer parameters
   * @param {string} params.address Recipient's address
   * @param {number} params.value Amount, in the coin's base unit
   * @returns {Promise<{success: boolean, hash?: string, error?: string}>}
   */
  async send(params) {
    const { address, value } = params;
    const fee = this.FEE;

    if (!this.isValidAddress(address)) {
      const error = `'${address}' is not a valid ${this.token} address`;

      log.error(`Refusing to send ${value} ${this.token}: ${error}.`);

      return { success: false, error };
    }

    return this.withUtxoLock(async () => {
      try {
        const { hex, txid } = await this.createTransaction(address, value, fee);

        log.log(
          `Successfully built Tx ${txid} to send ${value} ${this.token} to ${address} with a ${fee} ${this.token} fee.`,
        );

        const hash = await this.sendTransaction(hex);

        if (!hash) {
          return {
            success: false,
            hash: txid,
            isAmbiguous: true,
            error: 'Unable to confirm whether the Tx was broadcast; the node did not return a transaction id',
          };
        }

        log.log(
          `Successfully broadcast a Tx to send ${value} ${this.token} to ${address} with a ${fee} ${this.token} fee, Tx hash: ${hash}.`,
        );

        return { success: true, hash };
      } catch (error) {
        log.warn(
          `Error while sending ${value} ${this.token} to ${address} with a ${fee} ${this.token} fee in send() of ${utils.getModuleName(module.id)} module: ${error}`,
        );

        return { success: false, error: error.toString() };
      }
    });
  }

  /**
   * Maps a node's transaction into the bot's common shape.
   *
   * Adapters normalize their node's response into `vin[].address` and
   * `vout[].scriptPubKey.addresses` before calling this, because Insight-, Esplora-
   * and Core-style nodes all name those fields differently.
   *
   * @param {object} tx Normalized node transaction
   * @returns {object} Transaction in the bot's common shape, or the input when it cannot be mapped
   */
  mapTransaction(tx) {
    try {
      const senders = utils
        .getUnique(tx.vin.map((input) => input.address))
        .filter((sender) => sender !== undefined && sender !== 'undefined');

      let recipients = utils
        .getUnique(tx.vout.flatMap((out) => out.scriptPubKey?.addresses ?? []))
        .filter((recipient) => recipient !== undefined && recipient !== 'undefined');

      // An in-chat transfer has a single sender.
      const senderId = senders.length === 1 ? senders[0] : `${senders.length} addresses`;

      // An in-chat transfer has two outputs: the recipient and the change back to the sender.
      recipients = recipients.filter((recipient) => recipient !== senderId);
      const recipientId = recipients.length === 1 ? recipients[0] : `${recipients.length} addresses`;

      // Only meaningful with a single recipient; with more, the sum is 0.
      const amount = tx.vout
        .reduce((sum, out) => (recipientId === out.scriptPubKey?.addresses?.[0] ? sum + Number(out.value) : sum), 0)
        .toFixed(this.decimals);

      let fee = tx.fees;

      if (fee === undefined) {
        const totalIn = tx.vin.reduce((sum, input) => sum + (input.value ? Number(input.value) : 0), 0);
        const totalOut = tx.vout.reduce((sum, out) => sum + (out.value ? Number(out.value) : 0), 0);

        fee = (totalIn - totalOut).toFixed(this.decimals);
      }

      return {
        id: tx.txid,
        hash: tx.txid,
        blockId: tx.blockhash,
        fee: Number(fee),
        // `undefined` means "not confirmed yet"; UTXO nodes do not report a failed Tx.
        status: tx.confirmations > 0 ? true : undefined,
        timestamp: tx.time ? tx.time * 1000 : undefined,
        senders,
        senderId,
        recipients,
        recipientId,
        amount: Number(amount),
        confirmations: tx.confirmations,
        height: tx.height,
        hex: tx.hex,
        instantlock: tx.instantlock,
        instantlock_internal: tx.instantlock_internal,
        chainlock: tx.chainlock,
      };
    } catch (error) {
      log.warn(
        `Error while formatting Tx ${tx?.txid} for ${this.token} of ${utils.getModuleName(module.id)} module: ${error}`,
      );

      return tx;
    }
  }

  /**
   * Builds a human-readable one-line description of a transaction.
   *
   * @param {object} tx Transaction in the bot's common shape
   * @returns {string}
   */
  formTxMessage(tx) {
    try {
      const status = tx.status ? ' is accepted' : tx.status === false ? ' has FAILED' : '';
      const amount = tx.amount ? ` for ${tx.amount} ${this.token}` : '';
      const height = tx.height ? `${status ? ' and' : ' is'} included at ${tx.height} blockchain height` : '';
      const confirmations = tx.confirmations ? ` and has ${tx.confirmations} confirmations` : '';
      const instantSend =
        !height && !confirmations && tx.instantlock && tx.instantlock_internal
          ? `${status ? ' and' : ' is'} locked with InstantSend`
          : '';
      const time = tx.timestamp ? ` (${utils.formatDate(tx.timestamp).YYYY_MM_DD_hh_mm} — ${tx.timestamp})` : '';
      const fee = tx.fee || tx.fee === 0 ? `, ${tx.fee} ${this.token} fee` : '';
      const senderId = utils.isStringEqualCI(tx.senderId, this.address) ? 'Me' : tx.senderId;
      const recipientId = utils.isStringEqualCI(tx.recipientId, this.address) ? 'Me' : tx.recipientId;

      return `Tx ${tx.hash}${amount} from ${senderId} to ${recipientId}${status}${instantSend}${height}${time}${confirmations}${fee}`;
    } catch (error) {
      log.warn(
        `Error while building a message for Tx ${tx?.id} for ${this.token} of ${utils.getModuleName(module.id)} module: ${error}`,
      );

      return String(tx?.id);
    }
  }

  /**
   * Logs the balance and chain height the bot starts with.
   *
   * @returns {Promise<void>}
   */
  async logInitialState() {
    const [balance, lastBlockHeight] = await Promise.all([this.getBalance(), this.getLastBlockHeight()]);

    log.log(
      `Initial ${this.token} balance: ${
        utils.isPositiveOrZeroNumber(balance) ? balance.toFixed(constants.PRINT_DECIMALS) : 'unable to receive'
      }`,
    );
    log.log(
      `Last ${this.token} block height: ${
        utils.isPositiveOrZeroNumber(lastBlockHeight) ? lastBlockHeight : 'unable to receive'
      }`,
    );
  }

  /**
   * Runs `operation` while holding this wallet's UTXO lock.
   *
   * `exchangePayer` and `sendBack` run on independent timers, so two concurrent
   * transfers can otherwise read the same UTXO set and spend the same outpoint.
   *
   * @param {() => Promise<object>} operation Transfer operation
   * @returns {Promise<object>} The operation's result
   */
  async withUtxoLock(operation) {
    const previous = this.utxoLock ?? Promise.resolve();
    let release;

    const lock = new Promise((resolve) => {
      release = resolve;
    });

    this.utxoLock = lock;

    await previous;

    try {
      return await operation();
    } finally {
      release();

      if (this.utxoLock === lock) {
        this.utxoLock = undefined;
      }
    }
  }
};
