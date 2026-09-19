const { buildConfig, ConfigError } = require('../../modules/configSchema');

/** A throwaway passphrase that controls no funds; the derived address is U14172822264918400879. */
const TEST_PASSPHRASE = 'badge inherit crop candy beauty also close furnace dragon tiger battle figure';

/**
 * Returns a minimal valid config, with any field overridden.
 *
 * @param {object} [overrides] Fields to replace or remove
 * @returns {object}
 */
function rawConfig(overrides = {}) {
  return {
    passPhrase: TEST_PASSPHRASE,
    node_ADM: ['http://localhost:36666'],
    node_BTC: ['http://localhost:3001'],
    node_ETH: ['http://localhost:8545'],
    infoservice: ['http://localhost:36668'],
    accepted_crypto: ['ADM', 'BTC'],
    exchange_crypto: ['ADM', 'BTC'],
    known_crypto: ['ADM', 'BTC'],
    ...overrides,
  };
}

describe('buildConfig', () => {
  test('derives the bot’s identity from the passphrase', () => {
    const config = buildConfig(rawConfig(), { version: '3.0.0' });

    expect(config.address).toBe('U14172822264918400879');
    expect(config.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(config.keyPair).toBeDefined();
    expect(config.version).toBe('3.0.0');
  });

  test('builds the notification name from the bot name and address', () => {
    const config = buildConfig(rawConfig({ bot_name: 'My Bot' }));

    expect(config.notifyName).toBe('My Bot (U14172822264918400879)');
  });

  test('rejects a config that is not an object', () => {
    expect(() => buildConfig(undefined)).toThrow(ConfigError);
    expect(() => buildConfig('{}')).toThrow(/not a JSON object/);
  });

  test('rejects a missing or implausibly short passphrase', () => {
    expect(() => buildConfig(rawConfig({ passPhrase: undefined }))).toThrow(/passPhrase/);
    expect(() => buildConfig(rawConfig({ passPhrase: 'too short' }))).toThrow(/passPhrase/);
  });

  test('never repeats the passphrase in an error message', () => {
    // An operator reads these messages off a terminal and pastes them into issues,
    // so no rejection path may echo the passphrase back.
    const invalidConfigs = [
      rawConfig({ node_ADM: undefined }),
      rawConfig({ exchange_fee: '5' }),
      rawConfig({ log_level: 'verbose' }),
      rawConfig({ accepted_crypto: ['DOGE'] }),
      rawConfig({ known_crypto: ['ADM', 'LSK'], accepted_crypto: ['ADM'], exchange_crypto: ['ADM'] }),
      rawConfig({ exchange_fee_BTC: 'two percent' }),
    ];

    for (const invalid of invalidConfigs) {
      expect(() => buildConfig(invalid)).toThrow(ConfigError);

      try {
        buildConfig(invalid);
      } catch (error) {
        expect(error.message).not.toContain(TEST_PASSPHRASE);
      }
    }
  });

  test.each(['node_ADM', 'infoservice', 'accepted_crypto', 'exchange_crypto', 'known_crypto'])(
    'rejects a config without %s',
    (field) => {
      expect(() => buildConfig(rawConfig({ [field]: undefined }))).toThrow(new RegExp(`'${field}' is required`));
    },
  );

  test('rejects a field of the wrong type', () => {
    expect(() => buildConfig(rawConfig({ node_ADM: 'http://localhost:36666' }))).toThrow(/must be of type string\[\]/);
    expect(() => buildConfig(rawConfig({ exchange_fee: '5' }))).toThrow(/must be of type number/);
    expect(() => buildConfig(rawConfig({ socket: 'yes' }))).toThrow(/must be of type boolean/);
    expect(() => buildConfig(rawConfig({ reserved_deposit_senders: '0xabc' }))).toThrow(/must be of type string\[\]/);
  });

  test('rejects an out-of-range fee', () => {
    expect(() => buildConfig(rawConfig({ exchange_fee: -1 }))).toThrow(/not less than 0/);
    expect(() => buildConfig(rawConfig({ exchange_fee: 101 }))).toThrow(/not greater than 100/);
  });

  test('rejects an unknown log level or socket protocol', () => {
    expect(() => buildConfig(rawConfig({ log_level: 'verbose' }))).toThrow(/must be one of/);
    expect(() => buildConfig(rawConfig({ ws_type: 'http' }))).toThrow(/must be one of/);
  });

  test('applies defaults for everything that is not set', () => {
    const config = buildConfig(rawConfig());

    expect(config.socket).toBe(true);
    expect(config.ws_type).toBe('ws');
    expect(config.log_level).toBe('log');
    expect(config.erc20).toEqual([]);
    expect(config.reserved_deposit_senders).toEqual([]);
    expect(config.db_url).toBe('mongodb://localhost:27017/');
    expect(config.db_name).toBe('exchangerdb');
    expect(config.min_confirmations).toBe(3);
  });

  test.each(['none', 'error', 'warn', 'info', 'log', 'debug', 'trace'])(
    'accepts supported log level %s',
    (logLevel) => {
      const config = buildConfig(rawConfig({ log_level: logLevel }));

      expect(config.log_level).toBe(logLevel);
    },
  );

  test('rejects a coin that is accepted but not known', () => {
    expect(() => buildConfig(rawConfig({ accepted_crypto: ['ADM', 'DOGE'] }))).toThrow(
      /'accepted_crypto' includes coins missing from 'known_crypto': DOGE/,
    );
  });

  test('rejects a coin that is paid out but not known', () => {
    expect(() => buildConfig(rawConfig({ exchange_crypto: ['DASH'] }))).toThrow(/'exchange_crypto' includes coins/);
  });

  test('rejects an ERC-20 token that is not known', () => {
    expect(() => buildConfig(rawConfig({ erc20: ['USDT'] }))).toThrow(/'erc20' includes coins/);
  });

  test('rejects a known coin the bot has no adapter for', () => {
    expect(() =>
      buildConfig(
        rawConfig({
          known_crypto: ['ADM', 'BTC', 'LSK'],
        }),
      ),
    ).toThrow(/Coin 'LSK' in 'known_crypto' is not supported/);
  });

  test('rejects a known coin with no node list', () => {
    expect(() =>
      buildConfig(
        rawConfig({
          known_crypto: ['ADM', 'BTC', 'DOGE'],
          accepted_crypto: ['ADM'],
          exchange_crypto: ['ADM'],
        }),
      ),
    ).toThrow(/DOGE needs 'node_DOGE'/);
  });

  test('routes ERC-20 tokens to the Ethereum node list', () => {
    const config = buildConfig(
      rawConfig({
        known_crypto: ['ADM', 'BTC', 'USDT'],
        erc20: ['USDT'],
      }),
    );

    expect(config.erc20).toEqual(['USDT']);
  });

  test('rejects an ERC-20 token when there is no Ethereum node list', () => {
    expect(() =>
      buildConfig(
        rawConfig({
          known_crypto: ['ADM', 'BTC', 'USDT'],
          erc20: ['USDT'],
          node_ETH: [],
        }),
      ),
    ).toThrow(/USDT needs 'node_ETH'/);
  });
});

describe('per-coin config overrides', () => {
  test('every known coin inherits the general value', () => {
    const config = buildConfig(rawConfig({ exchange_fee: 5, min_confirmations: 4, daily_limit_usd: 500 }));

    for (const coin of ['ADM', 'BTC']) {
      expect(config[`exchange_fee_${coin}`]).toBe(5);
      expect(config[`min_confirmations_${coin}`]).toBe(4);
      expect(config[`daily_limit_usd_${coin}`]).toBe(500);
    }
  });

  test('an explicit override wins over the general value', () => {
    const config = buildConfig(rawConfig({ exchange_fee: 5, exchange_fee_BTC: 2 }));

    expect(config.exchange_fee_BTC).toBe(2);
    expect(config.exchange_fee_ADM).toBe(5);
  });

  test('an override of 0 is honoured rather than treated as unset', () => {
    const config = buildConfig(rawConfig({ daily_limit_usd: 500, daily_limit_usd_BTC: 0 }));

    expect(config.daily_limit_usd_BTC).toBe(0);
  });

  test('`false` means "inherit", as the shipped config documents', () => {
    const config = buildConfig(rawConfig({ exchange_fee: 5, exchange_fee_ADM: false }));

    expect(config.exchange_fee_ADM).toBe(5);
  });

  test('price guards default to 0, which means disabled', () => {
    const config = buildConfig(rawConfig());

    for (const coin of ['ADM', 'BTC']) {
      expect(config[`max_buy_price_usd_${coin}`]).toBe(0);
      expect(config[`min_sell_price_usd_${coin}`]).toBe(0);
      expect(config[`fixed_buy_price_usd_${coin}`]).toBe(0);
      expect(config[`fixed_sell_price_usd_${coin}`]).toBe(0);
    }
  });

  test('rejects a non-numeric per-coin override', () => {
    expect(() => buildConfig(rawConfig({ exchange_fee_BTC: 'two percent' }))).toThrow(
      /'exchange_fee_BTC' must be a number/,
    );
  });
});

describe('the shipped config.default.jsonc', () => {
  const fs = require('fs');
  const path = require('path');
  const jsonminify = require('jsonminify');

  const raw = JSON.parse(
    jsonminify(fs.readFileSync(path.resolve(__dirname, '..', '..', 'config.default.jsonc'), 'utf-8')),
  );

  test('parses as JSON once its comments are stripped', () => {
    expect(typeof raw).toBe('object');
  });

  test('passes validation once the placeholder passphrase is replaced', () => {
    expect(raw.passPhrase).toBe('adamant wallet twelve words here');
    expect(() => buildConfig({ ...raw, passPhrase: TEST_PASSPHRASE }, { version: '3.0.0' })).not.toThrow();
  });

  test('mentions no Lisk fields', () => {
    expect(raw.node_LSK).toBeUndefined();
    expect(raw.service_LSK).toBeUndefined();
    expect(raw.known_crypto).not.toContain('LSK');
    expect(raw.accepted_crypto).not.toContain('LSK');
    expect(raw.exchange_crypto).not.toContain('LSK');
  });

  test('ships no real Slack webhook or notification address', () => {
    expect(raw.slack).toBe('');
    expect(raw.adamant_notify).toBe('');
  });
});
