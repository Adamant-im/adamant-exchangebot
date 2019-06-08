const jsonminify = require('jsonminify');
const fs = require('fs');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const keys = require('adamant-api/helpers/keys');
const ENV = process.argv.reverse()[0] === 'dev' && 'dev' || 'prod';
console.log({ENV});
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
	node_ETH: {
		type: Array,
		default: ['https://ethnode1.adamant.im']
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
	welcome_string: {
		type: String,
		default: `Hello 😊. I didn’t understand you. I am exchange bot, anonymous and work instant. Learn more about me on ADAMANT’s blog or type /help to see what I can.`
	}
};
try {
	if (ENV === 'dev') {
		config = require('../tests');}
	else {
		config = JSON.parse(jsonminify(fs.readFileSync('./config.json', 'utf-8')));
	}

	let keysPair;
	try {
		keysPair = keys.createKeypairFromPassPhrase(config.passphrase);
	} catch (e) {
		exit('Passphrase is not a valide!' + e);
	}
	const address = keys.createAddressFromPublicKey(keysPair.publicKey);
	config.publicKey = keysPair.publicKey;
	config.address = address;

	Object.keys(fields).forEach(f => {
		if (!config[f] && fields[f].isRequired) {
			exit(`Exchange Bot ${address} config is wrong. Field ${f} is not valid. Cannot start Bot.`);
		} else if (!config[f] && fields[f].default) {
			config[f] = fields[f].default;
		}
		if (fields[f].type !== config[f].__proto__.constructor) {
			exit(`Exchange Bot ${address} config is wrong. Fields type ${f} is not valid, must be ${fields[f].type.name}. Cannot start Bot.`);
		}
	});

} catch (e) {
	log.error('Err config: ' + e);
}

function exit(msg) {
	notify(msg, 'error');
	process.exit(-1);
}
module.exports = config;
