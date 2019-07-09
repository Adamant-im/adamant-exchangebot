const jsonminify = require('jsonminify');
const fs = require('fs');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const keys = require('adamant-api/helpers/keys');
const isDev = process.argv.reverse()[0] === 'dev';
let config = {};

// Validate config fields
const fields = {
	passPhrase: {
		type: String,
		isRequired: true
	},
	node_ADM: {
		type: Array,
		isRequired: true
	},
	node_ETH: {
		type: Array,
		default: ['https://ethnode1.adamant.im']
	},
	exchange_crypto: {
		type: Array,
		isRequired: true
	},
	accepted_crypto: {
		type: Array,
		isRequired: true
	},
	known_crypto: {
		type: Array,
		isRequired: true
	},
	infoservice: {
		type: Array,
		default: ['https://info.adamant.im']
	},
	min_value_usd: {
		type: Number,
		default: 1
	},
	daily_limit_usd: {
		type: Number,
		default: 1000
	},
	min_confirmations: {
		type: Number,
		default: 3
	},
	exchange_fee: {
		type: Number,
		default: 1
	},
	adamant_notify: {
		type: String,
		default: null
	},
	slack: {
		type: String,
		default: null
	},
	welcome_string: {
		type: String,
		default: 'Hello 😊. I didn’t understand you. I am exchange bot, anonymous and work instant. Learn more about me on ADAMANT’s blog or type */help* to see what I can.'
	}
};
try {
	if (isDev) {
		config = require('../tests');
	} else {
		config = JSON.parse(jsonminify(fs.readFileSync('./config.json', 'utf-8')));
	}

	let keysPair;
	try {
		keysPair = keys.createKeypairFromPassPhrase(config.passphrase);
	} catch (e) {
		exit('Passphrase is not valid! Error:' + e);
	}
	const address = keys.createAddressFromPublicKey(keysPair.publicKey);
	config.publicKey = keysPair.publicKey;
	config.address = address;


	['min_confirmations', 'exchange_fee', 'min_value_usd'].forEach(param => {
		config.known_crypto.forEach(coin => {
			const field = param + '_' + coin;
			config[field] = config[field] || config[param] || fields[param].default;
			if (fields[param].type !== config[field].__proto__.constructor) {
				exit(`Exchange Bot ${address} config is wrong. Field type _${field}_ is not valid, expected type is _${fields[field].type.name}_. Cannot start Bot.`);
			}
		});
	});

	Object.keys(fields).forEach(f => {
		if (!config[f] && fields[f].isRequired) {
			exit(`Exchange Bot ${address} config is wrong. Field _${f}_ is not valid. Cannot start Bot.`);
		} else if (!config[f] && fields[f].default) {
			config[f] = fields[f].default;
		}
		if (config[f] && fields[f].type !== config[f].__proto__.constructor) {
			exit(`Exchange Bot ${address} config is wrong. Field type _${f}_ is not valid, expected type is _${fields[f].type.name}_. Cannot start Bot.`);
		}
	});

} catch (e) {
	log.error('Error reading config: ' + e);
}

function exit(msg) {
	log.error(msg);
	process.exit(-1);
}
config.isDev = isDev;
module.exports = config;
