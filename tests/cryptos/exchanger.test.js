jest.mock('axios');
jest.mock('../../modules/api', () => ({ getKVS: jest.fn(), getKvsRecord: jest.fn() }));
jest.mock('../../modules/DB', () => ({
  paymentsDb: { find: jest.fn().mockResolvedValue([]) },
  incomingTxsDb: { find: jest.fn().mockResolvedValue([]) },
  systemDb: { findOne: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const axios = require('axios');

const api = require('../../modules/api');
const db = require('../../modules/DB');
const config = require('../../modules/configReader');
const constants = require('../../helpers/const');
const exchangerUtils = require('../../helpers/cryptos/exchanger');

/** A realistic slice of an ADAMANT InfoService response. */
const RATES = {
  'USD/USD': 1,
  'EUR/USD': 1.16,
  'BTC/USD': 80000,
  'ETH/USD': 2500,
  'ADM/USD': 0.01,
  'DASH/USD': 55,
  'DOGE/USD': 0.08,
  'USDT/USD': 1,
  'ADM/BTC': 0.000000125,
  'BTC/ADM': 8000000,
};

beforeAll(() => {
  exchangerUtils.init();
});

beforeEach(() => {
  exchangerUtils.currencies = { ...RATES };
});

describe('exchanger.init', () => {
  test('builds an adapter for every known coin', () => {
    for (const coin of config.known_crypto) {
      expect(exchangerUtils[coin]).toBeDefined();
      expect(exchangerUtils[coin].token).toBe(coin);
    }
  });

  test('every ERC-20 adapter shares the Ethereum wallet', () => {
    for (const token of config.erc20) {
      expect(exchangerUtils[token].account.address).toBe(exchangerUtils.ETH.account.address);
    }
  });

  test('is idempotent, so a second call does not rebuild the wallets', () => {
    const btc = exchangerUtils.BTC;

    exchangerUtils.init();

    expect(exchangerUtils.BTC).toBe(btc);
  });
});

describe('exchanger.updateCryptoRates', () => {
  test('stores the rates the InfoService returns', async () => {
    axios.mockResolvedValue({ data: { success: true, result: { 'BTC/USD': 1 } } });

    await exchangerUtils.updateCryptoRates();

    expect(exchangerUtils.currencies).toEqual({ 'BTC/USD': 1 });
  });

  test('keeps the previous rates when the response has an unexpected shape', async () => {
    axios.mockResolvedValue({ data: { success: false } });

    await exchangerUtils.updateCryptoRates();

    expect(exchangerUtils.currencies).toEqual(RATES);
  });

  test('keeps the previous rates when every InfoService is unreachable', async () => {
    axios.mockRejectedValue(new Error('ECONNREFUSED'));

    await exchangerUtils.updateCryptoRates();

    expect(exchangerUtils.currencies).toEqual(RATES);
  });
});

describe('exchanger.getRate', () => {
  test('uses a directly quoted pair', () => {
    expect(exchangerUtils.getRate('BTC', 'ADM')).toBe(8000000);
  });

  test('inverts a pair quoted the other way round', () => {
    exchangerUtils.currencies = { 'BTC/ADM': 8000000 };

    expect(exchangerUtils.getRate('ADM', 'BTC')).toBe(1 / 8000000);
  });

  test('goes through USD when neither direction is quoted', () => {
    exchangerUtils.currencies = { 'BTC/USD': 80000, 'ETH/USD': 2500 };

    expect(exchangerUtils.getRate('BTC', 'ETH')).toBe(32);
  });

  test('treats USD itself as worth one USD', () => {
    exchangerUtils.currencies = { 'BTC/USD': 80000 };

    expect(exchangerUtils.getRate('BTC', 'USD')).toBe(80000);
    expect(exchangerUtils.getRate('USD', 'BTC')).toBe(1 / 80000);
  });

  test('returns undefined when there are no rates at all', () => {
    exchangerUtils.currencies = undefined;

    expect(exchangerUtils.getRate('BTC', 'ADM')).toBeUndefined();
  });

  test('uses a fixed buy price for the coin the bot receives', () => {
    config.fixed_buy_price_usd_ADM = 0.02;

    try {
      // The bot values the ADM it receives at 0.02 USD rather than the market 0.01.
      expect(exchangerUtils.getRate('ADM', 'USD')).toBe(0.02);
    } finally {
      config.fixed_buy_price_usd_ADM = 0;
    }
  });

  test('uses a fixed sell price for the coin the bot sends', () => {
    config.fixed_sell_price_usd_BTC = 100000;

    try {
      expect(exchangerUtils.getRate('USD', 'BTC')).toBe(1 / 100000);
    } finally {
      config.fixed_sell_price_usd_BTC = 0;
    }
  });
});

describe('exchanger.convertCryptos', () => {
  test('converts at the market rate when no fee is applied', () => {
    const { outAmount, exchangePrice } = exchangerUtils.convertCryptos('BTC', 'ADM', 1);

    expect(exchangePrice).toBe(8000000);
    expect(outAmount).toBe(8000000);
  });

  test('accepts lower-case tickers', () => {
    expect(exchangerUtils.convertCryptos('btc', 'adm', 1).outAmount).toBe(8000000);
  });

  test('deducts the service fee and the outgoing network fee', () => {
    // The fixture config charges 10% on incoming ADM and 5% otherwise.
    const { outAmount, exchangePrice } = exchangerUtils.convertCryptos('ADM', 'DASH', 1000000, true);
    const dashFee = exchangerUtils.DASH.FEE;

    const unroundedRate = (0.01 / 55) * 0.9;

    // `exchangePrice` is the rate rounded for display, while `outAmount` is computed
    // from the full-precision rate — on a large amount the two differ visibly.
    expect(exchangePrice).toBe(Number(unroundedRate.toFixed(constants.PRECISION_DECIMALS)));
    expect(outAmount).toBe(Number((unroundedRate * 1000000 - dashFee).toFixed(constants.PRECISION_DECIMALS)));
  });

  test('falls back to the general fee for a coin without an override', () => {
    const withOverride = exchangerUtils.convertCryptos('ADM', 'DASH', 1, true).exchangePrice;
    const withoutOverride = exchangerUtils.convertCryptos('BTC', 'DASH', 1, true).exchangePrice;

    expect(withOverride).toBe(Number(((0.01 / 55) * 0.9).toFixed(constants.PRECISION_DECIMALS)));
    expect(withoutOverride).toBe(Number(((80000 / 55) * 0.95).toFixed(constants.PRECISION_DECIMALS)));
  });

  test('charges an ERC-20 payout the ETH network fee converted into the token', () => {
    exchangerUtils.ETH.gasPrice = 20000000000n;

    try {
      const feeInEth = exchangerUtils.USDT.FEE;
      const feeInUsdt = exchangerUtils.convertCryptos('ETH', 'USDT', feeInEth).outAmount;
      const { outAmount, exchangePrice } = exchangerUtils.convertCryptos('BTC', 'USDT', 1, true);

      expect(feeInUsdt).toBeGreaterThan(0);
      expect(outAmount).toBeCloseTo(exchangePrice - feeInUsdt, 6);
    } finally {
      exchangerUtils.ETH.gasPrice = 0n;
    }
  });

  test('returns NaN rather than a wrong number when the rate is unknown', () => {
    expect(exchangerUtils.convertCryptos('BTC', 'NOPE', 1)).toEqual({ outAmount: NaN, exchangePrice: NaN });
    expect(exchangerUtils.convertCryptos('NOPE', 'BTC', 1)).toEqual({ outAmount: NaN, exchangePrice: NaN });
  });

  test('returns NaN when the bot has no adapter for the outgoing coin', () => {
    exchangerUtils.currencies = { ...RATES, 'NOPE/USD': 1 };

    expect(exchangerUtils.convertCryptos('BTC', 'NOPE', 1, true).outAmount).toBeNaN();
  });

  test('can return a negative amount, which the caller must reject', () => {
    // A dust transfer that does not cover the outgoing network fee.
    const { outAmount } = exchangerUtils.convertCryptos('ADM', 'DASH', 0.0001, true);

    expect(outAmount).toBeLessThan(0);
  });
});

describe('exchanger coin predicates', () => {
  test('recognizes ERC-20 tokens case-insensitively', () => {
    expect(exchangerUtils.isERC20('USDT')).toBe(true);
    expect(exchangerUtils.isERC20('usdt')).toBe(true);
    expect(exchangerUtils.isERC20('BTC')).toBe(false);
  });

  test('recognizes everything that pays its fee in ETH', () => {
    expect(exchangerUtils.isEthOrERC20('ETH')).toBe(true);
    expect(exchangerUtils.isEthOrERC20('USDT')).toBe(true);
    expect(exchangerUtils.isEthOrERC20('BTC')).toBe(false);
  });

  test('separates known, accepted and exchanged coins', () => {
    expect(exchangerUtils.isKnown('USDC')).toBe(true);
    expect(exchangerUtils.isAccepted('USDC')).toBe(false);
    expect(exchangerUtils.isExchanged('USDC')).toBe(false);
    expect(exchangerUtils.isAccepted('BTC')).toBe(true);
    expect(exchangerUtils.isKnown('LSK')).toBe(false);
  });

  test('recognizes fiat and instant-settling coins', () => {
    expect(exchangerUtils.isFiat('USD')).toBe(true);
    expect(exchangerUtils.isFiat('BTC')).toBe(false);
    expect(exchangerUtils.isFastPayments('DASH')).toBe(true);
    expect(exchangerUtils.isFastPayments('BTC')).toBe(false);
  });
});

describe('exchanger.hasTicker', () => {
  test('finds a coin quoted as the base of the very first pair', () => {
    exchangerUtils.currencies = { 'ADM/USD': 0.01, 'BTC/USD': 80000 };

    expect(exchangerUtils.hasTicker('ADM')).toBe(true);
  });

  test('finds a coin quoted only as the quote currency', () => {
    exchangerUtils.currencies = { 'BTC/ADM': 8000000 };

    expect(exchangerUtils.hasTicker('ADM')).toBe(true);
  });

  test('matches whole tickers only, not a prefix of one', () => {
    exchangerUtils.currencies = { 'USDT/USD': 1 };

    // USD is genuinely present as the quote currency; USD_ is not present at all.
    expect(exchangerUtils.hasTicker('USD')).toBe(true);
    expect(exchangerUtils.hasTicker('USDT')).toBe(true);
    expect(exchangerUtils.hasTicker('USDTT')).toBe(false);
    expect(exchangerUtils.hasTicker('US')).toBe(false);
  });

  test('returns false when there are no rates yet', () => {
    exchangerUtils.currencies = undefined;

    expect(exchangerUtils.hasTicker('BTC')).toBe(false);
  });
});

describe('exchanger.isLowerThanMinBalance', () => {
  test('rejects an amount at or below the coin’s minimum', () => {
    expect(exchangerUtils.isLowerThanMinBalance(constants.minBalances.BTC, 'BTC')).toBe(true);
    expect(exchangerUtils.isLowerThanMinBalance(constants.minBalances.BTC / 2, 'BTC')).toBe(true);
  });

  test('accepts an amount above the minimum', () => {
    expect(exchangerUtils.isLowerThanMinBalance(constants.minBalances.BTC * 2, 'BTC')).toBe(false);
  });

  test('accepts any positive amount for a coin with no minimum', () => {
    expect(exchangerUtils.isLowerThanMinBalance(0.00000001, 'ADM')).toBe(false);
  });
});

describe('exchanger.userDailyValue', () => {
  test('sums the USD value of a user’s completed exchanges', async () => {
    db.paymentsDb.find.mockResolvedValue([{ inAmountMessageUsd: 10 }, { inAmountMessageUsd: 15.5 }]);

    await expect(exchangerUtils.userDailyValue('U1')).resolves.toBe(25.5);
  });

  test('returns zero when the user has exchanged nothing', async () => {
    db.paymentsDb.find.mockResolvedValue([]);

    await expect(exchangerUtils.userDailyValue('U1')).resolves.toBe(0);
  });

  test('looks only at the last 24 hours of that user’s valid exchanges', async () => {
    db.paymentsDb.find.mockResolvedValue([]);

    await exchangerUtils.userDailyValue('U1');

    const query = db.paymentsDb.find.mock.calls[0][0];

    expect(query.senderId).toBe('U1');
    expect(query.transactionIsValid).toBe(true);
    expect(query.needToSendBack).toBe(false);
    expect(query.date.$gt).toBeGreaterThan(Date.now() - constants.DAY - 1000);
  });
});

describe('exchanger.getKvsCryptoAddress', () => {
  test('returns the address the user published', async () => {
    api.getKvsRecord.mockResolvedValue({
      success: true,
      transactions: [{ senderId: 'U1', asset: { state: { key: 'eth:address', value: '0xabc' } } }],
    });

    await expect(exchangerUtils.getKvsCryptoAddress('ETH', 'U1')).resolves.toBe('0xabc');
    expect(api.getKvsRecord).toHaveBeenCalledWith({
      senderId: 'U1',
      key: 'eth:address',
      orderBy: 'timestamp:desc',
      limit: 1,
    });
  });

  test('looks up an ERC-20 token under the user’s Ethereum address', async () => {
    api.getKvsRecord.mockResolvedValue({ success: true, transactions: [] });

    await exchangerUtils.getKvsCryptoAddress('USDT', 'U1');

    expect(api.getKvsRecord).toHaveBeenCalledWith(expect.objectContaining({ key: 'eth:address' }));
  });

  test('ignores a record written by another account under another key', async () => {
    api.getKvsRecord.mockResolvedValue({
      success: true,
      transactions: [{ senderId: 'U999', asset: { state: { key: 'eth:address', value: '0xstranger' } } }],
    });

    await expect(exchangerUtils.getKvsCryptoAddress('ETH', 'U1')).resolves.toBeUndefined();
  });

  test('returns "none" when the user has published no address', async () => {
    api.getKvsRecord.mockResolvedValue({ success: true, transactions: [] });

    await expect(exchangerUtils.getKvsCryptoAddress('BTC', 'U1')).resolves.toBe('none');
  });

  test('returns undefined when the KVS cannot be read, so the bot retries later', async () => {
    api.getKvsRecord.mockResolvedValue({ success: false, errorMessage: 'node down' });

    await expect(exchangerUtils.getKvsCryptoAddress('BTC', 'U1')).resolves.toBeUndefined();
  });
});

describe('exchanger coin lists', () => {
  test('lists the coins it accepts and exchanges', () => {
    expect(exchangerUtils.acceptedCryptoList).toBe(config.accepted_crypto.join(', '));
    expect(exchangerUtils.exchangedCryptoList).toBe(config.exchange_crypto.join(', '));
  });

  test('says so plainly when the two lists match', () => {
    expect(exchangerUtils.isAcceptedAndExchangedEqual()).toBe(true);
    expect(exchangerUtils.iAcceptAndExchangeString).toContain('I exchange anything between');
  });

  test('names both lists when they differ', () => {
    const accepted = config.accepted_crypto;

    config.accepted_crypto = ['ADM'];

    try {
      expect(exchangerUtils.iAcceptAndExchangeString).toContain('I accept *ADM* for exchange to');
    } finally {
      config.accepted_crypto = accepted;
    }
  });

  test('offers only the coins it actually holds, excluding the one being sent', async () => {
    for (const coin of config.exchange_crypto) {
      exchangerUtils[coin].getBalance = jest.fn().mockResolvedValue(1);
      Object.defineProperty(exchangerUtils[coin], 'balance', { configurable: true, get: () => 1 });
    }

    Object.defineProperty(exchangerUtils.DOGE, 'balance', { configurable: true, get: () => 0 });

    const list = await exchangerUtils.getExchangedCryptoList('BTC');

    expect(list).not.toContain('BTC');
    expect(list).not.toContain('DOGE');
    expect(list).toContain('ADM');
    // The last separator reads as a choice.
    expect(list).toContain(' or ');
  });
});
