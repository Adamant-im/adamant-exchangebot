module.exports = class baseCoin {

	// object lastBlock, === balance
	cache = {
		getData(data) {
			if (this[data] && this[data].timestamp && (Date.now() - this[data].timestamp < this[data].lifetime))
				return this[data].value
			else
				return undefined
		},
		cacheData(data, value) {
			this[data].value = value;
			this[data].timestamp = Date.now();
		}
	}

	account = {
		passPhrase: undefined,
		privateKey: undefined,
		keysPair: undefined,
		address: undefined
	}

};
