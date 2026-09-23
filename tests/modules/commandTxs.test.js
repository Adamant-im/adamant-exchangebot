jest.mock('../../helpers/messenger', () => ({ sendMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../helpers/cryptos/exchanger', () => ({
  currencies: {},
  hasTicker: jest.fn(),
  isAccepted: jest.fn(),
  isExchanged: jest.fn(),
  isERC20: jest.fn(),
  isFiat: jest.fn(),
  convertCryptos: jest.fn(),
  getRate: jest.fn(),
  userDailyValue: jest.fn(),
  refreshExchangedBalances: jest.fn().mockResolvedValue(undefined),
  iAcceptAndExchangeString: 'I exchange anything between *ADM, BTC*',
  ADM: { getBalance: jest.fn(), balance: 1000, FEE: 0.5 },
  BTC: { getBalance: jest.fn(), balance: 1, FEE: 0.0001 },
  ETH: { getBalance: jest.fn(), balance: 1, FEE: 0.005 },
  DASH: { getBalance: jest.fn(), balance: 1, FEE: 0.0001 },
  DOGE: { getBalance: jest.fn(), balance: 1000, FEE: 1 },
  USDT: { getBalance: jest.fn(), balance: 100, FEE: 0.005 },
}));
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));
jest.mock('../../helpers/notify', () => jest.fn());
jest.mock('../../modules/DB', () => ({
  paymentsDb: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
}));

const messenger = require('../../helpers/messenger');
const exchangerUtils = require('../../helpers/cryptos/exchanger');
const log = require('../../helpers/log');
const notify = require('../../helpers/notify');
const db = require('../../modules/DB');
const config = require('../../modules/configReader');
const commandTxs = require('../../modules/commandTxs');

const { commands } = commandTxs;
const USER = 'U16655734187932477074';

const RATES = { 'ADM/USD': 0.01, 'ADM/BTC': 0.000000125, 'BTC/USD': 80000 };

beforeEach(() => {
  exchangerUtils.currencies = { ...RATES };
  exchangerUtils.hasTicker.mockImplementation((coin) => ['ADM', 'BTC', 'USD'].includes(coin));
  exchangerUtils.isAccepted.mockReturnValue(true);
  exchangerUtils.isExchanged.mockReturnValue(true);
  exchangerUtils.isERC20.mockReturnValue(false);
  exchangerUtils.isFiat.mockImplementation((coin) => coin === 'USD');
  exchangerUtils.getRate.mockReturnValue(1);
  exchangerUtils.userDailyValue.mockResolvedValue(0);
  // A USD value well above the minimum, and a payout well inside the mocked balances.
  exchangerUtils.convertCryptos.mockImplementation((from, to, amount) =>
    to === 'USD'
      ? { outAmount: Number(amount) * 100, exchangePrice: 100 }
      : { outAmount: Number(amount) * 0.0001, exchangePrice: 0.0001 },
  );
  exchangerUtils.ADM.getBalance.mockResolvedValue(1000);
  exchangerUtils.BTC.getBalance.mockResolvedValue(1);
  exchangerUtils.ETH.getBalance.mockResolvedValue(1);
  messenger.sendMessage.mockResolvedValue(true);
});

describe('/help', () => {
  test('lists every command the bot answers', () => {
    const result = commands.help([], {}, undefined);

    for (const command of ['/rates', '/calc', '/balances', '/test', '/cancel', '/version']) {
      expect(result).toContain(command);
    }
  });

  test('states the fee and the special fee for a coin that has one', () => {
    // The fixture config takes 5% generally and 10% on incoming ADM.
    const result = commands.help([], {}, undefined);

    expect(result).toContain('*5%* fee');
    expect(result).toContain('10% fee if you send me ADM');
  });

  test('shows the daily limit when the config asks for it', () => {
    expect(commands.help([], {}, undefined)).toContain('daily exchange limit is *1000* USD');
  });

  test('hides the daily limit when the config asks it to', () => {
    config.daily_limit_show = false;

    try {
      expect(commands.help([], {}, undefined)).not.toContain('daily exchange limit');
    } finally {
      config.daily_limit_show = true;
    }
  });

  test('explains the slash only when the user’s message had to be corrected', () => {
    expect(commands.help([], {}, 'help')).toContain('every command starts with a slash');
    expect(commands.help([], {}, undefined)).not.toContain('every command starts with a slash');
  });
});

describe('/rates', () => {
  test('lists every pair quoted for a coin', () => {
    const result = commands.rates(['ADM']);

    expect(result).toContain('ADM/**USD**');
    expect(result).toContain('ADM/**BTC**');
  });

  test('accepts a lower-case ticker', () => {
    expect(commands.rates(['adm'])).toContain('ADM/**USD**');
  });

  test('asks for a ticker when none is given', () => {
    expect(commands.rates([])).toContain('Please specify the coin ticker');
  });

  test('says so when it has no rates for the coin', () => {
    expect(commands.rates(['XYZ'])).toContain('don’t have rates for the coin *XYZ*');
  });

  test('says so when the coin is quoted only as a quote currency', () => {
    exchangerUtils.currencies = { 'ADM/USD': 0.01 };

    expect(commands.rates(['USD'])).toContain('can’t get rates for *USD*');
  });
});

describe('/calc', () => {
  test('converts at the market rate', () => {
    expect(commands.calc(['2', 'BTC', 'in', 'USD'])).toBe('The market value of 2 BTC is 200 USD.');
  });

  test('rounds a fiat result to two decimals and bolds the whole part', () => {
    exchangerUtils.convertCryptos.mockReturnValue({ outAmount: 1.23456789, exchangePrice: 1 });

    expect(commands.calc(['1', 'BTC', 'in', 'USD'])).toContain('**1**.23 USD');
  });

  test('keeps full precision for a crypto result', () => {
    exchangerUtils.convertCryptos.mockReturnValue({ outAmount: 0.00012345, exchangePrice: 1 });
    exchangerUtils.isFiat.mockReturnValue(false);

    expect(commands.calc(['1', 'USD', 'in', 'BTC'])).toContain('.00012345 BTC');
  });

  test('rejects the wrong number of arguments', () => {
    expect(commands.calc(['2', 'BTC'])).toContain('Wrong arguments');
  });

  test('rejects a non-numeric amount', () => {
    expect(commands.calc(['lots', 'BTC', 'in', 'USD'])).toContain('Wrong amount');
  });

  test('rejects a coin it has no rates for', () => {
    expect(commands.calc(['2', 'XYZ', 'in', 'USD'])).toContain('don’t have rates for the coin *XYZ*');
    expect(commands.calc(['2', 'BTC', 'in', 'XYZ'])).toContain('don’t have rates for the coin *XYZ*');
  });

  test('reports a conversion it cannot make', () => {
    exchangerUtils.convertCryptos.mockReturnValue({ outAmount: NaN, exchangePrice: NaN });

    expect(commands.calc(['2', 'BTC', 'in', 'USD'])).toContain('Unable to convert');
  });
});

describe('/test', () => {
  test('quotes an exchange the bot can make', async () => {
    const result = await commands.test(['1', 'ADM', 'to', 'BTC'], { senderId: USER });

    expect(result).toContain('let’s make a deal');
  });

  test('rejects the wrong number of arguments', async () => {
    await expect(commands.test(['1', 'ADM'])).resolves.toContain('Wrong arguments');
  });

  test('refuses a coin it does not accept', async () => {
    exchangerUtils.isAccepted.mockReturnValue(false);

    await expect(commands.test(['1', 'ADM', 'to', 'BTC'])).resolves.toContain('don’t accept *ADM*');
  });

  test('refuses a coin it does not pay out in', async () => {
    exchangerUtils.isExchanged.mockReturnValue(false);

    await expect(commands.test(['1', 'ADM', 'to', 'BTC'])).resolves.toContain('don’t exchange to *BTC*');
  });

  test('refuses to exchange a coin for itself', async () => {
    await expect(commands.test(['1', 'ADM', 'to', 'ADM'])).resolves.toContain('must be joking');
  });

  test('refuses an amount below the minimum value', async () => {
    exchangerUtils.convertCryptos.mockReturnValue({ outAmount: 0.5, exchangePrice: 1 });

    await expect(commands.test(['1', 'ADM', 'to', 'BTC'])).resolves.toContain('minimum exchange value');
  });

  test('refuses an amount that does not cover the network fee', async () => {
    exchangerUtils.convertCryptos.mockImplementation((from, to, amount, considerFee) => ({
      outAmount: considerFee ? -1 : 100,
      exchangePrice: 1,
    }));

    await expect(commands.test(['1', 'ADM', 'to', 'BTC'])).resolves.toContain('doesn’t cover the network Tx fee');
  });

  test('refuses when the bot does not hold enough of the outgoing coin', async () => {
    exchangerUtils.BTC.getBalance.mockResolvedValue(0.0001);

    await expect(commands.test(['1', 'ADM', 'to', 'BTC'], { senderId: USER })).resolves.toContain(
      'don’t have enough coins',
    );
  });

  test('mentions Ether specifically when an ERC-20 payout has no gas', async () => {
    exchangerUtils.isERC20.mockReturnValue(true);
    exchangerUtils.hasTicker.mockReturnValue(true);
    exchangerUtils.ETH.getBalance.mockResolvedValue(0);
    exchangerUtils.USDT.getBalance.mockResolvedValue(1000);

    await expect(commands.test(['1', 'ADM', 'to', 'USDT'], { senderId: USER })).resolves.toContain(
      'don’t have enough Ether',
    );
  });

  test('refuses when the user is already over their daily limit', async () => {
    config.daily_limit_usd_BTC = 100;
    exchangerUtils.userDailyValue.mockResolvedValue(100);

    try {
      await expect(commands.test(['1', 'ADM', 'to', 'BTC'], { senderId: USER })).resolves.toContain(
        'exceeded the maximum daily volume',
      );
    } finally {
      config.daily_limit_usd_BTC = 0;
    }
  });

  test('refuses when the exchange would push the user over their daily limit', async () => {
    config.daily_limit_usd_BTC = 100;
    exchangerUtils.userDailyValue.mockResolvedValue(50);
    exchangerUtils.convertCryptos.mockReturnValue({ outAmount: 60, exchangePrice: 1 });

    try {
      await expect(commands.test(['1', 'ADM', 'to', 'BTC'], { senderId: USER })).resolves.toContain(
        'would exceed the maximum daily volume',
      );
    } finally {
      config.daily_limit_usd_BTC = 0;
    }
  });

  test('refuses to buy above the configured maximum price', async () => {
    config.max_buy_price_usd_ADM = 0.005;
    exchangerUtils.getRate.mockReturnValue(0.01);

    try {
      await expect(commands.test(['1', 'ADM', 'to', 'BTC'], { senderId: USER })).resolves.toContain('too high');
    } finally {
      config.max_buy_price_usd_ADM = 0;
    }
  });

  test('refuses to sell below the configured minimum price', async () => {
    config.min_sell_price_usd_BTC = 100000;
    exchangerUtils.getRate.mockReturnValue(80000);

    try {
      await expect(commands.test(['1', 'ADM', 'to', 'BTC'], { senderId: USER })).resolves.toContain('too low');
    } finally {
      config.min_sell_price_usd_BTC = 0;
    }
  });
});

describe('/balances', () => {
  test('refreshes and lists the balance of every coin it pays out in', async () => {
    const result = await commands.balances();

    expect(exchangerUtils.refreshExchangedBalances).toHaveBeenCalled();

    for (const coin of config.exchange_crypto) {
      expect(result).toContain(`_${coin}_`);
    }
  });

  test('shows a question mark for a balance it could not read', async () => {
    Object.defineProperty(exchangerUtils.BTC, 'balance', { configurable: true, get: () => undefined });

    try {
      expect(await commands.balances()).toContain('? _BTC_');
    } finally {
      Object.defineProperty(exchangerUtils.BTC, 'balance', { configurable: true, value: 1, writable: true });
    }
  });
});

describe('/version', () => {
  test('reports the running version', () => {
    expect(commands.version()).toContain(config.version);
  });
});

describe('/cancel', () => {
  test('cancels a pending exchange awaiting clarification and queues it for refund', async () => {
    const payment = {
      _id: 'pay-1',
      admTxId: 'tx-1',
      senderId: USER,
      inCurrency: 'ADM',
      inAmountMessage: 5,
      inUpdateState: 'outCurrency',
      update: jest.fn().mockResolvedValue(undefined),
    };

    db.paymentsDb.find.mockResolvedValue([payment]);

    const result = await commands.cancel([], { senderId: USER });

    expect(db.paymentsDb.find).toHaveBeenCalledWith({
      senderId: USER,
      inUpdateState: { $nin: [null, undefined] },
      needToSendBack: { $ne: true },
    });
    expect(payment.update).toHaveBeenCalledWith(
      { needToSendBack: true, isBasicChecksPassed: true, inUpdateState: undefined },
      true,
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('cancelled the pending exchange'), 'info');
    expect(result).toContain('I’ve cancelled your exchange of _5_ _ADM_');
  });

  test('ignores payments where inUpdateState has already transitioned to null', async () => {
    const payment = {
      _id: 'pay-clarified',
      senderId: USER,
      inCurrency: 'ADM',
      inAmountMessage: 5,
      inUpdateState: null,
      update: jest.fn(),
    };

    db.paymentsDb.find.mockResolvedValue([payment]);

    const result = await commands.cancel([], { senderId: USER });

    expect(payment.update).not.toHaveBeenCalled();
    expect(result).toBe('You don’t have any pending exchange awaiting clarification to cancel.');
  });

  test('reports when there is no pending exchange to cancel', async () => {
    db.paymentsDb.find.mockResolvedValue([]);

    const result = await commands.cancel([], { senderId: USER });

    expect(result).toBe('You don’t have any pending exchange awaiting clarification to cancel.');
  });
});

describe('the command dispatcher', () => {
  /**
   * Builds the stored incoming transaction a command arrives with.
   *
   * @returns {object}
   */
  function incomingTx() {
    return { _id: 'adm-tx-1', commandFix: undefined, update: jest.fn().mockResolvedValue(undefined) };
  }

  test('runs a command and replies to the user', async () => {
    const itx = incomingTx();

    await commandTxs('/version', { id: 'adm-tx-1', senderId: USER }, itx);

    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('adamant-exchangebot'));
    expect(itx.update).toHaveBeenCalledWith({ isProcessed: true }, true);
  });

  test('tolerates any amount of whitespace between arguments', async () => {
    await commandTxs('/calc   2   BTC   in   USD', { id: 'adm-tx-1', senderId: USER }, incomingTx());

    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('market value'));
  });

  test('answers an unknown command with a pointer to /help', async () => {
    await commandTxs('/nonsense', { id: 'adm-tx-1', senderId: USER }, incomingTx());

    expect(messenger.sendMessage).toHaveBeenCalledWith(USER, expect.stringContaining('don’t know the */nonsense*'));
  });

  test('logs and moves on when a command throws', async () => {
    exchangerUtils.refreshExchangedBalances.mockRejectedValue(new Error('node down'));

    await expect(commandTxs('/balances', { id: 'adm-tx-1', senderId: USER }, incomingTx())).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Error while processing'));
  });
});
