const api = require('../../modules/api');
const config = require('../../modules/configReader');
const db = require('../../modules/DB');
const log = require('../log');
const constants = require('../const');
const utils = require('../utils');
const { NodeClient } = require('./nodeClient');

const AdmCoin = require('./adm_utils');
const BtcCoin = require('./btc_utils');
const DashCoin = require('./dash_utils');
const DogeCoin = require('./doge_utils');
const EthCoin = require('./eth_utils');
const Erc20Coin = require('./erc20_utils');

/** Fiat tickers the InfoService quotes, used to decide how many decimals to print. */
const FIAT_TICKERS = ['USD', 'RUB', 'EUR', 'CNY', 'JPY'];

/** Coins whose transfers are effectively instant, so the bot does not make the user wait. */
const FAST_PAYMENT_TICKERS = ['DASH', 'ADM'];

/** How a ticker maps to its adapter. ERC-20 tokens are handled separately, on top of ETH. */
const COIN_ADAPTERS = {
  ADM: () => new AdmCoin(),
  BTC: () => new BtcCoin('BTC'),
  DASH: () => new DashCoin('DASH'),
  DOGE: () => new DogeCoin('DOGE'),
  ETH: () => new EthCoin('ETH'),
};

const infoServiceClient = new NodeClient('InfoService', config.infoservice);

module.exports = {
  /**
   * Latest exchange rates from ADAMANT InfoService, keyed by pair, for example `BTC/USD`.
   *
   * @type {Record<string, number>|undefined}
   */
  currencies: undefined,

  /** Whether {@link init} has already built the coin adapters. */
  isInitialized: false,

  /**
   * Builds the coin adapters for every coin in `known_crypto`.
   *
   * Adapters derive wallets and open node connections, so they are created once,
   * explicitly, at startup — not as a side effect of requiring this module.
   *
   * @returns {void}
   */
  init() {
    if (this.isInitialized) {
      return;
    }

    const needsEther = config.erc20.length > 0 || config.known_crypto.includes('ETH');

    if (needsEther) {
      this.ETH = COIN_ADAPTERS.ETH();
    }

    for (const coin of config.known_crypto) {
      if (coin === 'ETH' || config.erc20.includes(coin)) {
        continue;
      }

      const createAdapter = COIN_ADAPTERS[coin];

      if (!createAdapter) {
        // The config validator rejects unsupported coins, so this should be unreachable.
        throw new Error(`No adapter is implemented for '${coin}'.`);
      }

      this[coin] = createAdapter();
    }

    for (const token of config.erc20) {
      this[token] = new Erc20Coin(token, this.ETH);
    }

    this.isInitialized = true;
  },

  /**
   * Starts the background work the adapters need: fee and gas price tracking, and
   * logging the balances the bot starts with.
   *
   * @returns {Promise<void>}
   */
  async startCoinUpdates() {
    await Promise.all([this.ETH?.startGasPriceUpdates(), this.BTC?.startFeeUpdates()].filter(Boolean));

    await Promise.all(config.known_crypto.map((coin) => this[coin]?.logInitialState()).filter(Boolean));
  },

  /**
   * Fetches the current exchange rates from ADAMANT InfoService.
   *
   * @returns {Promise<void>}
   */
  async updateCryptoRates() {
    const response = await infoServiceClient.request({ endpoint: '/get', description: 'crypto rates' });
    const rates = response?.result;

    if (rates && typeof rates === 'object') {
      this.currencies = rates;

      return;
    }

    log.warn(
      `Unable to fetch crypto rates in updateCryptoRates() of ${utils.getModuleName(module.id)} module. The request succeeded, but the response had an unexpected shape.`,
    );
  },

  /**
   * Starts refreshing the exchange rates in the background.
   *
   * @returns {void}
   */
  startRatesUpdates() {
    this.ratesInterval = setInterval(() => {
      void this.updateCryptoRates();
    }, constants.UPDATE_CRYPTO_RATES_INTERVAL);

    this.ratesInterval.unref?.();
  },

  /**
   * Returns how many units of `to` one unit of `from` is worth.
   *
   * When a fixed price is configured for either side, it replaces the market price.
   * The bot buys the incoming coin and sells the outgoing one, so `fixed_buy_price_usd`
   * applies to `from` and `fixed_sell_price_usd` applies to `to`.
   *
   * @param {string} from Ticker the bot receives, for example `ADM`
   * @param {string} to Ticker the bot sends, for example `ETH`
   * @returns {number|undefined} The rate, or `undefined` when it cannot be calculated
   */
  getRate(from, to) {
    try {
      if (!this.currencies) {
        return undefined;
      }

      const fixedBuyPrice = config[`fixed_buy_price_usd_${from}`];
      const fixedSellPrice = config[`fixed_sell_price_usd_${to}`];

      if (fixedBuyPrice || fixedSellPrice) {
        let priceFrom = from === 'USD' ? 1 : this.currencies[`${from}/USD`];
        let priceTo = to === 'USD' ? 1 : this.currencies[`${to}/USD`];

        if (fixedBuyPrice) {
          log.warn(
            `Using the fixed ${from} rate of ${fixedBuyPrice} USD instead of the market rate of ${priceFrom} USD to convert ${from} to ${to} (buying ${from}).`,
          );
          priceFrom = fixedBuyPrice;
        }

        if (fixedSellPrice) {
          log.warn(
            `Using the fixed ${to} rate of ${fixedSellPrice} USD instead of the market rate of ${priceTo} USD to convert ${from} to ${to} (selling ${to}).`,
          );
          priceTo = fixedSellPrice;
        }

        return priceFrom / priceTo;
      }

      const directRate = this.currencies[`${from}/${to}`];

      if (directRate) {
        return directRate;
      }

      const reverseRate = this.currencies[`${to}/${from}`];

      if (reverseRate) {
        return 1 / reverseRate;
      }

      // Neither direction is quoted; go through USD.
      const priceFrom = from === 'USD' ? 1 : this.currencies[`${from}/USD`];
      const priceTo = to === 'USD' ? 1 : this.currencies[`${to}/USD`];

      return priceFrom / priceTo;
    } catch (error) {
      log.error(
        `Unable to calculate the price of ${from} in ${to} in getRate() of ${utils.getModuleName(module.id)} module: ${error}`,
      );

      return undefined;
    }
  },

  /**
   * Converts an amount of one coin into another.
   *
   * @param {string} from Ticker the bot receives
   * @param {string} to Ticker the bot sends
   * @param {number} [amount=1] Amount of `from`
   * @param {boolean} [considerExchangerFee=false] Deduct the bot's service fee and the outgoing network fee
   * @returns {{outAmount: number, exchangePrice: number}} Both values are `NaN` when the conversion is impossible
   */
  convertCryptos(from, to, amount = 1, considerExchangerFee = false) {
    const failed = { outAmount: NaN, exchangePrice: NaN };

    try {
      const fromTicker = String(from).toUpperCase();
      const toTicker = String(to).toUpperCase();

      let rate = this.getRate(fromTicker, toTicker);

      if (!utils.isPositiveNumber(rate)) {
        return failed;
      }

      let networkFee = 0;

      if (considerExchangerFee) {
        const exchangeFee = config[`exchange_fee_${fromTicker}`] ?? config.exchange_fee;

        rate *= 1 - exchangeFee / 100;

        const outCoin = this[toTicker];

        if (!outCoin) {
          return failed;
        }

        networkFee = outCoin.FEE;

        // An ERC-20 payout costs ETH, but the user is charged in the token they receive.
        if (this.isERC20(toTicker)) {
          networkFee = this.convertCryptos('ETH', toTicker, networkFee).outAmount;
        }

        if (!utils.isPositiveOrZeroNumber(networkFee)) {
          return failed;
        }
      }

      const value = rate * Number(amount) - networkFee;

      if (!utils.isNumber(value)) {
        return failed;
      }

      return {
        outAmount: Number(value.toFixed(constants.PRECISION_DECIMALS)),
        exchangePrice: Number(rate.toFixed(constants.PRECISION_DECIMALS)),
      };
    } catch (error) {
      log.error(
        `Unable to calculate ${amount} ${from} in ${to} in convertCryptos() of ${utils.getModuleName(module.id)} module: ${error}`,
      );

      return failed;
    }
  },

  /**
   * Reads a user's address for a coin from the ADAMANT KVS.
   *
   * ERC-20 tokens share the user's Ethereum address.
   *
   * @param {string} coin Ticker
   * @param {string} admAddress User's ADAMANT address
   * @returns {Promise<string|undefined>} The address, `'none'` when the user has not published one,
   *   or `undefined` when the KVS could not be read
   */
  async getKvsCryptoAddress(coin, admAddress) {
    const record = await this.getKvsCryptoAddressRecord(coin, admAddress);

    return record === 'none' ? 'none' : record?.address;
  },

  /**
   * Reads the address together with the ADAMANT block that confirmed the KVS value.
   *
   * The block height is part of the ownership decision for an external deposit:
   * an address published only after the transfer entered the mempool cannot claim it.
   *
   * @param {string} coin Ticker
   * @param {string} admAddress User's ADAMANT address
   * @returns {Promise<object|string|undefined>} KVS record, `'none'`, or `undefined` on failure
   */
  async getKvsCryptoAddressRecord(coin, admAddress) {
    const kvsCoin = this.isERC20(coin) ? 'ETH' : coin;

    const response = await api.getKVS({
      senderId: admAddress,
      key: `${kvsCoin.toLowerCase()}:address`,
      orderBy: 'timestamp:desc',
    });

    if (!response.success) {
      log.warn(
        `Failed to get the ${kvsCoin} address of ${admAddress} from the KVS in getKvsCryptoAddress() of ${utils.getModuleName(module.id)} module. ${response.errorMessage}.`,
      );

      return undefined;
    }

    const record = response.transactions?.[0];

    return record
      ? {
          address: record.asset.state.value,
          height: record.height,
          timestamp: record.timestamp,
          transactionId: record.id,
        }
      : 'none';
  },

  /**
   * Returns how much a user has exchanged in the last 24 hours, in USD.
   *
   * @param {string} senderId User's ADAMANT address
   * @returns {Promise<number>}
   */
  async userDailyValue(senderId) {
    const payments = await db.paymentsDb.find({
      transactionIsValid: true,
      senderId,
      needToSendBack: false,
      inAmountMessageUsd: { $ne: null },
      date: { $gt: utils.unix() - constants.DAY },
    });

    return payments.reduce((total, payment) => total + Number(payment.inAmountMessageUsd), 0);
  },

  /**
   * Refreshes the balances of every coin the bot pays out in.
   *
   * @returns {Promise<void>}
   */
  async refreshExchangedBalances() {
    await Promise.all(config.exchange_crypto.map((coin) => this[coin].getBalance()));
  },

  /**
   * Whether a coin is an ERC-20 token.
   *
   * @param {string} coin Ticker
   * @returns {boolean}
   */
  isERC20(coin) {
    return config.erc20.includes(String(coin).toUpperCase());
  },

  /**
   * Whether a coin is ETH or an ERC-20 token, that is, whether it pays fees in ETH.
   *
   * @param {string} coin Ticker
   * @returns {boolean}
   */
  isEthOrERC20(coin) {
    return String(coin).toUpperCase() === 'ETH' || this.isERC20(coin);
  },

  /**
   * Whether the bot has an adapter for a coin.
   *
   * @param {string} coin Ticker
   * @returns {boolean}
   */
  isKnown(coin) {
    return config.known_crypto.includes(coin);
  },

  /**
   * Whether the bot accepts a coin for exchange.
   *
   * @param {string} coin Ticker
   * @returns {boolean}
   */
  isAccepted(coin) {
    return config.accepted_crypto.includes(coin);
  },

  /**
   * Whether the bot pays out in a coin.
   *
   * @param {string} coin Ticker
   * @returns {boolean}
   */
  isExchanged(coin) {
    return config.exchange_crypto.includes(coin);
  },

  /**
   * Whether the bot accepts and pays out in exactly the same set of coins.
   *
   * @returns {boolean}
   */
  isAcceptedAndExchangedEqual() {
    return utils.isArraysEqual(config.accepted_crypto, config.exchange_crypto);
  },

  /**
   * Coins the bot accepts, as a comma-separated list.
   *
   * @returns {string}
   */
  get acceptedCryptoList() {
    return config.accepted_crypto.join(', ');
  },

  /**
   * Coins the bot pays out in, as a comma-separated list.
   *
   * @returns {string}
   */
  get exchangedCryptoList() {
    return config.exchange_crypto.join(', ');
  },

  /**
   * A sentence describing what the bot accepts and what it pays out in.
   *
   * @returns {string}
   */
  get iAcceptAndExchangeString() {
    if (this.isAcceptedAndExchangedEqual()) {
      return `I exchange anything between *${this.acceptedCryptoList}*`;
    }

    return `I accept *${this.acceptedCryptoList}* for exchange to *${this.exchangedCryptoList}*`;
  },

  /**
   * Coins the bot can currently pay out in, that is, those it holds a balance of.
   *
   * @param {string} [excludeCoin] Coin to leave out, normally the one the user is sending
   * @returns {Promise<string>} A human-readable list, for example `BTC, ETH or ADM`
   */
  async getExchangedCryptoList(excludeCoin) {
    const excluded = excludeCoin ? excludeCoin.toUpperCase() : '';

    await this.refreshExchangedBalances();

    const available = config.exchange_crypto.filter((coin) => coin !== excluded && this[coin].balance > 0);

    return utils.replaceLastOccurrence(available.join(', '), ', ', ' or ');
  },

  /**
   * Whether a ticker is a fiat currency.
   *
   * @param {string} coin Ticker
   * @returns {boolean}
   */
  isFiat(coin) {
    return FIAT_TICKERS.includes(coin);
  },

  /**
   * Whether transfers of a coin are effectively instant.
   *
   * @param {string} coin Ticker
   * @returns {boolean}
   */
  isFastPayments(coin) {
    return FAST_PAYMENT_TICKERS.includes(coin);
  },

  /**
   * Whether the InfoService quotes a coin in any pair.
   *
   * @param {string} coin Ticker
   * @returns {boolean}
   */
  hasTicker(coin) {
    if (!this.currencies) {
      return false;
    }

    return Object.keys(this.currencies).some((pair) => {
      const [base, quote] = pair.split('/');

      return base === coin || quote === coin;
    });
  },

  /**
   * Whether an amount is too small to send.
   *
   * @param {number} transferAmount Amount to send, in the coin's base unit
   * @param {string} coin Ticker
   * @returns {boolean}
   */
  isLowerThanMinBalance(transferAmount, coin) {
    const minBalance = constants.minBalances[coin] || 0;

    return transferAmount <= minBalance;
  },
};
