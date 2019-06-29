const Store = require('../modules/Store');
const $u = require('../helpers/utils');
const config = require('./configReader');
const api = require('./api');
const db = require('./DB');

module.exports = async (cmd, tx, itx) => {
	console.log('Command TX!', cmd);
	try {
		let msg = '';
		const group = cmd
			.trim()
			.replace(/    /g, ' ')
			.replace(/   /g, ' ')
			.replace(/  /g, ' ')
			.split(' ');
		const methodName = group.shift().trim().replace('\/', '');
		const m = commands[methodName];
		if (m){
			msg = await m(group, tx);
		} else {
			msg = `I don’t know /${methodName} command. Let’s start with /help.`;
		}
		$u.sendAdmMsg(tx.senderId, msg);
		itx.update({isProcessed: true}, true);
	} catch (e){
		$u.sendAdmMsg(tx.senderId, 'Error command...'); // TODO: need msg
	}
};

function help() {
	return `
I understand commands:
*/rates* — I will provide Coinmarketcap exchange rates for specific coin. Add coin ticker after space. F. e., /rates ADM or /rates USD.
*/calc* — I will calculate one coin value in another using Coinmarketcap exchange rates. Works like this: /calc 2.05 BTC in USD.
*/balances* — I will show my crypto balances. Don’t request exchange if I don’t have enough balance for coin you need.
*/test* — I will estimate information on exchange request. Do it before each exchange. Works like this: /test 0.35 ETH to ADM. So you’ll know how much you’ll receive in return. Note, real value may differ because of rates update. I will pay blockchain fees by myself.
To make an exchange, just send me crypto here in chat and comment with crypto ticker you want to get back. F. e., if you want to exchange 0.35 ETH for ADM, send In-Chat payment of 0.35 ETH to me with “ADM” comment.
*Important! Don’t write anything else in comment, otherwise I will send your transfer back to you.*
`;
}

async function rates(arr) {
	const [coin] = arr;
	if (!coin){
		return 'Please specify coin ticker you are interested in. F. e., /rates ADM.';
	}
	const tickers = await api.syncGet(config.infoservice + '/get?coin=' + coin, true);
	if (!tickers || !tickers.success){
		return `I can’t get rates for ${coin}. Made a typo? Try /rates ADM`;
	}
	const res = tickers.result;
	return `What I’ve got:
	` + Object.keys(res).map(t => `${t} ${res[t]}`)
		.join(', ');
}

function calc(arr) {
	if (arr.length !== 4) { // error request
		return 'U command is not valid! Command works like this: /calc 2.05 BTC in USD.';
	}

	const amount = +arr[0];
	const inCurrency = arr[1].toUpperCase().trim();
	const outCurrency = arr[3].toUpperCase().trim();
	const {known_crypto} = config;

	if (!known_crypto.includes(inCurrency)) {
		return `I don’t know crypto ${inCurrency}. Command works like this: /calc 2.05 BTC in USD.`;
	}
	if (!known_crypto.includes(outCurrency)) {
		return `I don’t know crypto ${outCurrency}. Command works like this: /calc 2.05 BTC in USD.`;
	}
	const result = Store.mathEqual(inCurrency, outCurrency, amount, true).outAmount;

	if (result <= 0 || !result) {
		return 'I didn’t understand amount for <currency>. Command works like this: /calc 2.05 BTC in USD.'; // TODO: <currency>??
	}
	if (['USD', 'RUB'].includes(outCurrency)) { // TODO: add all fiats
		result = +result.toFixed(2);
	}
	return `${$u.thousandSeparator(amount)} ${inCurrency} equals __${$u.thousandSeparator(result)} ${outCurrency}__`;
}

async function test(arr, tx) {
	if (arr.length !== 4) { // error request
		return 'U command is not valid! Command works like this: /calc 2.05 BTC in USD.';
	}

	const amount = +arr[0];
	const inCurrency = arr[1].toUpperCase().trim();
	const outCurrency = arr[3].toUpperCase().trim();
	const {known_crypto, accepted_crypto, exchange_crypto, daily_limit_usd} = config;

	if (!known_crypto.includes(inCurrency)) {
		return `I don’t know crypto ${inCurrency}. Command works like this: /calc 2.05 BTC in USD.`;
	}
	if (!known_crypto.includes(outCurrency)) {
		return `I don’t know crypto ${outCurrency}. Command works like this: /calc 2.05 BTC in USD.`;
	}
	if (!exchange_crypto.includes(inCurrency)) {
		return `I don’t accept exchange to ${inCurrency}. I accept ${accepted_crypto.join(', ')} and exchange them to ${exchange_crypto.join(', ')} `;
	}
	if (!accepted_crypto.includes(outCurrency)) {
		return `I don’t accept exchange to ${outCurrency}. I accept ${accepted_crypto.join(', ')} and exchange them to ${exchange_crypto.join(', ')} `;
	}
	const result = Store.mathEqual(inCurrency, outCurrency, amount).outAmount;

	if (result <= 0 || !result) {
		return 'I didn’t understand amount for <currency>. Command works like this: /calc 2.05 BTC in USD.'; // TODO: <currency>??
	}

	const usdEqual = Store.mathEqual(inCurrency, 'USD', amount).outAmount;
	if (usdEqual < config['min_value_usd_' + inCurrency]) {
		return `I don’t accept exchange of crypto below minimum value of ${config['min_value_usd_' + inCurrency]}. Exchange more coins.`;
	}

	if (['USD', 'RUB'].includes(outCurrency)) { // TODO: add all fiats
		result = +result.toFixed(2);
	}

	const userDailiValue = await $u.userDailiValue(tx.senderId);

	if (userDailiValue + usdEqual >= daily_limit_usd){
		return `You have exceeded maximum daily volume of ${daily_limit_usd}. Come back tomorrow`;
	}
	return `Ok. Let's make a bargain. I’ll give you ${result} ${outCurrency}. To proceed, send me ${amount} ${inCurrency} here in chat with comment ${outCurrency}. Don’t write anything else in comment, otherwise I will send your transfer back to you. And hurry up, while exchange rate is so good!
	`;
}

function balances() {
	return config.exchange_crypto.reduce((str, c) => {
		return str + `
		${$u.thousandSeparator(+Store.user[c].balance.toFixed(8))} _${c}_`;
	}, 'My crypto balances:');
}


const commands = {
	help,
	rates,
	calc,
	balances,
	test
};
