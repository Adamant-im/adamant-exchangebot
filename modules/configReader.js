const jsonminify = require('jsonminify');
const fs = require('fs');
const keys = require('adamant-api/src/helpers/keys');
const isDev = process.argv.includes('dev');
let config = {};

// Validate config fields
const fields = {
  passPhrase: {
    type: String,
    isRequired: true,
  },
  node_ADM: {
    type: Array,
    isRequired: true,
  },
  node_ETH: {
    type: Array,
    isRequired: true,
  },
  node_LSK: {
    type: Array,
    isRequired: true,
  },
  service_LSK: {
    type: Array,
    isRequired: true,
  },
  exchange_crypto: {
    type: Array,
    isRequired: true,
  },
  accepted_crypto: {
    type: Array,
    isRequired: true,
  },
  known_crypto: {
    type: Array,
    isRequired: true,
  },
  infoservice: {
    type: Array,
    isRequired: true,
  },
  min_value_usd: {
    type: Number,
    default: 1,
  },
  daily_limit_usd: {
    type: Number,
    default: 1000,
  },
  min_confirmations: {
    type: Number,
    default: 3,
  },
  exchange_fee: {
    type: Number,
    default: 1,
  },
  bot_name: {
    type: String,
    default: null,
  },
  adamant_notify: {
    type: String,
    default: null,
  },
  slack: {
    type: String,
    default: null,
  },
  log_level: {
    type: String,
    default: 'log',
  },
  welcome_string: {
    type: String,
    default: 'Hello 😊. This is a stub. I have nothing to say. Please check my config.',
  },
};

try {
  let configFile;
  if (isDev || process.env.JEST_WORKER_ID) {
    configFile = './config.test.jsonc';
  } else {
    if (fs.existsSync('./config.jsonc')) {
      configFile = './config.jsonc';
    } else {
      configFile = './config.default.jsonc';
    }
  }
  config = JSON.parse(jsonminify(fs.readFileSync(configFile, 'utf-8')));

  if (!config.node_ADM) {
    exit(`Bot's config is wrong. ADM nodes are not set. Cannot start the Bot.`);
  }
  if (!config.passPhrase || config.passPhrase.length < 35) {
    exit(`Bot's config is wrong. Set an ADAMANT passPhrase to manage the Bot.`);
  }

  let keyPair;
  try {
    keyPair = keys.createKeypairFromPassPhrase(config.passPhrase);
  } catch (e) {
    exit(`Bot's config is wrong. Invalid passPhrase. Error: ${e}. Cannot start the Bot.`);
  }
  const address = keys.createAddressFromPublicKey(keyPair.publicKey);
  config.keyPair = keyPair;
  config.publicKey = keyPair.publicKey.toString('hex');
  config.address = address;
  config.notifyName = `${config.bot_name} (${config.address})`;
  config.version = require('../package.json').version;

  ['min_confirmations', 'exchange_fee', 'daily_limit_usd',
    'max_buy_price_usd', 'min_sell_price_usd',
    'fixed_buy_price_usd', 'fixed_sell_price_usd'].forEach((param) => {
    config.known_crypto.forEach((coin) => {
      const field = param + '_' + coin;
      if (fields[param]) { // some params have default values
        if (!config[field] && config[field] !== 0) {
          config[field] = config[param] || fields[param].default;
        }
        if (fields[param].type !== config[field].__proto__.constructor) {
          exit(`Exchange Bot ${address} config is wrong. Field type _${field}_ is not valid, expected type is _${fields[param].type.name}_. Cannot start the Bot.`);
        }
      }
    });
  });

  Object.keys(fields).forEach((f) => {
    if (config[f] === undefined) {
      if (fields[f].isRequired) {
        exit(`Bot's ${address} config is wrong. Field _${f}_ is not valid. Cannot start Bot.`);
      } else if (fields[f].default !== undefined) {
        config[f] = fields[f].default;
      }
    }
    if (config[f] !== false && fields[f].type !== config[f].__proto__.constructor) {
      exit(`Bot's ${address} config is wrong. Field type _${f}_ is not valid, expected type is _${fields[f].type.name}_. Cannot start Bot.`);
    }
  });

  console.info(`The bot ${address} successfully read the config-file '${configFile}'${isDev ? ' (dev)' : ''}.`);
} catch (e) {
  console.error('Error reading config: ' + e);
}

config.isDev = isDev;
module.exports = config;

function exit(msg) {
  console.error(msg);
  process.exit(-1);
}
