const { createKeypairFromPassphrase, createAddressFromPublicKey } = require('adamant-api');

/** Verbosity levels accepted in `log_level`, from quietest to most verbose. */
const LOG_LEVELS = ['none', 'error', 'warn', 'info', 'log', 'debug', 'trace'];

/** Minimum length of an ADAMANT passphrase, used as a cheap sanity check before key derivation. */
const MIN_PASSPHRASE_LENGTH = 35;

/**
 * Parameters that can be overridden per coin by appending `_<TICKER>`,
 * for example `exchange_fee_ADM` or `min_confirmations_BTC`.
 *
 * `base` is the general parameter the per-coin value falls back to, and
 * `fallback` is used when the general parameter is not set either.
 */
const PER_COIN_FIELDS = [
  { name: 'min_confirmations', base: 'min_confirmations', fallback: 3 },
  { name: 'exchange_fee', base: 'exchange_fee', fallback: 0 },
  { name: 'daily_limit_usd', base: 'daily_limit_usd', fallback: 0 },
  { name: 'max_buy_price_usd', base: undefined, fallback: 0 },
  { name: 'min_sell_price_usd', base: undefined, fallback: 0 },
  { name: 'fixed_buy_price_usd', base: undefined, fallback: 0 },
  { name: 'fixed_sell_price_usd', base: undefined, fallback: 0 },
];

/**
 * Which node list each coin needs. ERC-20 tokens are served by the Ethereum nodes,
 * so they are resolved through `ETH`.
 */
const COIN_NODE_FIELDS = {
  ADM: 'node_ADM',
  ETH: 'node_ETH',
  BTC: 'node_BTC',
  DASH: 'node_DASH',
  DOGE: 'node_DOGE',
};

/** Declarative description of every top-level config field. */
const FIELDS = {
  passPhrase: { type: 'string', isRequired: true },

  node_ADM: { type: 'string[]', isRequired: true },
  node_ETH: { type: 'string[]', default: [] },
  node_BTC: { type: 'string[]', default: [] },
  node_DASH: { type: 'string[]', default: [] },
  node_DOGE: { type: 'string[]', default: [] },
  infoservice: { type: 'string[]', isRequired: true },

  socket: { type: 'boolean', default: true },
  ws_type: { type: 'string', default: 'ws', oneOf: ['ws', 'wss'] },

  accepted_crypto: { type: 'string[]', isRequired: true },
  exchange_crypto: { type: 'string[]', isRequired: true },
  known_crypto: { type: 'string[]', isRequired: true },
  erc20: { type: 'string[]', default: [] },

  exchange_fee: { type: 'number', default: 0, min: 0, max: 100 },
  min_value_usd: { type: 'number', default: 0, min: 0 },
  daily_limit_usd: { type: 'number', default: 0, min: 0 },
  daily_limit_show: { type: 'boolean', default: true },
  min_confirmations: { type: 'number', default: 3, min: 0 },

  db_url: { type: 'string', default: 'mongodb://localhost:27017/' },
  db_name: { type: 'string', default: 'exchangerdb' },

  bot_name: { type: 'string', default: 'Exchange Bot' },
  adamant_notify: { type: 'string', default: '' },
  slack: { type: 'string', default: '' },
  log_level: { type: 'string', default: 'log', oneOf: LOG_LEVELS },
  welcome_string: {
    type: 'string',
    default: 'Hello 😊. This is a stub. I have nothing to say. Please check my config.',
  },
};

/**
 * Thrown when the config cannot be used to start the bot.
 *
 * A dedicated class lets the caller decide what to do — the bot exits, tests assert.
 */
class ConfigError extends Error {
  /** @param {string} message Human-readable reason the config was rejected */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Checks a value against a field's declared type.
 *
 * @param {*} value Value to check
 * @param {string} type One of `string`, `number`, `boolean`, `string[]`
 * @returns {boolean}
 */
function isOfType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    default:
      return false;
  }
}

/**
 * Validates and normalizes every top-level field declared in {@link FIELDS}.
 *
 * @param {object} raw Parsed config file contents
 * @returns {object} A copy of `raw` with defaults applied
 * @throws {ConfigError} When a required field is missing or a value has the wrong type
 */
function applyFieldDefaults(raw) {
  const config = { ...raw };

  for (const [name, field] of Object.entries(FIELDS)) {
    const value = config[name];

    if (value === undefined || value === null) {
      if (field.isRequired) {
        throw new ConfigError(`Field '${name}' is required.`);
      }

      config[name] = field.default;
      continue;
    }

    if (!isOfType(value, field.type)) {
      throw new ConfigError(`Field '${name}' must be of type ${field.type}, got ${typeof value}.`);
    }

    if (field.oneOf && !field.oneOf.includes(value)) {
      throw new ConfigError(`Field '${name}' must be one of ${field.oneOf.join(', ')}, got '${value}'.`);
    }

    if (field.min !== undefined && value < field.min) {
      throw new ConfigError(`Field '${name}' must be not less than ${field.min}, got ${value}.`);
    }

    if (field.max !== undefined && value > field.max) {
      throw new ConfigError(`Field '${name}' must be not greater than ${field.max}, got ${value}.`);
    }
  }

  return config;
}

/**
 * Fills in `<param>_<TICKER>` values for every known coin.
 *
 * A per-coin value of `false`, `null` or `undefined` means "inherit", which is how
 * `config.default.jsonc` documents the overrides.
 *
 * @param {object} config Config with top-level defaults already applied
 * @throws {ConfigError} When a per-coin override is not a finite number
 */
function applyPerCoinDefaults(config) {
  for (const { name, base, fallback } of PER_COIN_FIELDS) {
    const generalValue = base === undefined ? undefined : config[base];

    for (const coin of config.known_crypto) {
      const field = `${name}_${coin}`;
      const value = config[field];

      if (value === undefined || value === null || value === false) {
        config[field] = generalValue ?? fallback;
        continue;
      }

      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ConfigError(`Field '${field}' must be a number, got ${typeof value}.`);
      }
    }
  }
}

/**
 * Verifies that the coin lists are consistent and that every coin has a node list.
 *
 * The bot indexes its coin adapters by ticker, so a coin that is accepted but not
 * known, or known but without nodes, becomes a runtime failure in the middle of an
 * exchange. It is much cheaper to refuse to start.
 *
 * @param {object} config Config with defaults applied
 * @throws {ConfigError} When the coin configuration cannot be served
 */
function validateCoins(config) {
  const known = new Set(config.known_crypto);

  for (const listName of ['accepted_crypto', 'exchange_crypto', 'erc20']) {
    const unknown = config[listName].filter((coin) => !known.has(coin));

    if (unknown.length) {
      throw new ConfigError(`Field '${listName}' includes coins missing from 'known_crypto': ${unknown.join(', ')}.`);
    }
  }

  const erc20 = new Set(config.erc20);
  const missingNodes = new Set();

  for (const coin of known) {
    const nodeField = erc20.has(coin) ? COIN_NODE_FIELDS.ETH : COIN_NODE_FIELDS[coin];

    if (!nodeField) {
      throw new ConfigError(`Coin '${coin}' in 'known_crypto' is not supported. Remove it or add it to 'erc20'.`);
    }

    if (!config[nodeField].length) {
      missingNodes.add(`${coin} needs '${nodeField}'`);
    }
  }

  if (missingNodes.size) {
    throw new ConfigError(`Node lists are missing for some coins: ${[...missingNodes].join('; ')}.`);
  }
}

/**
 * Validates a raw config and derives everything the bot needs to run.
 *
 * The function is pure: it neither reads files nor terminates the process, so it
 * can be exercised directly by tests.
 *
 * @param {object} raw Parsed config file contents
 * @param {object} [options] Extra values that do not come from the config file
 * @param {string} [options.version] Bot version, reported in `/version` and notifications
 * @param {boolean} [options.isDev] Whether the bot was started in development mode
 * @returns {object} The ready-to-use config
 * @throws {ConfigError} When the config cannot be used to start the bot
 */
function buildConfig(raw, { version = '', isDev = false } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('Config is empty or is not a JSON object.');
  }

  if (typeof raw.passPhrase !== 'string' || raw.passPhrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new ConfigError('Set an ADAMANT passPhrase to manage the bot.');
  }

  const config = applyFieldDefaults(raw);

  applyPerCoinDefaults(config);
  validateCoins(config);

  let keyPair;

  try {
    keyPair = createKeypairFromPassphrase(config.passPhrase);
  } catch (error) {
    // The passphrase itself must never reach the message.
    throw new ConfigError(`Invalid passPhrase: unable to derive a keypair. ${error.message}`);
  }

  config.keyPair = keyPair;
  config.publicKey = Buffer.from(keyPair.publicKey).toString('hex');
  config.address = createAddressFromPublicKey(keyPair.publicKey);
  config.notifyName = `${config.bot_name} (${config.address})`;
  config.version = version;
  config.isDev = isDev;

  return config;
}

module.exports = {
  ConfigError,
  FIELDS,
  LOG_LEVELS,
  PER_COIN_FIELDS,
  COIN_NODE_FIELDS,
  buildConfig,
};
