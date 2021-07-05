const Store = require('../modules/Store');
const constants = require('../helpers/const');
const config = require('./configReader');
const log = require('../helpers/log');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const api = require('./api');
const { UPDATE_CRYPTO_RATES_INVERVAL } = require('../helpers/const');

module.exports = async (commandMsg, tx, itx) => {
	try {

		log.log(`Processing '${commandMsg}' command from ${tx.recipientId} (transaction ${tx.id})…`);
		const group = commandMsg
			.trim()
			.replace(/    /g, ' ')
			.replace(/   /g, ' ')
			.replace(/  /g, ' ')
			.split(' ');
		const commandName = group.shift().trim().toLowerCase().replace('\/', '');
		const command = commands[commandName];

		let commandResult = '';
		if (command) {
			commandResult = await command(group, tx);
		} else {
			commandResult = `I don’t know */${commandName}* command. ℹ️ You can start with **/help**.`;
		}

		api.sendMessage(config.passPhrase, tx.senderId, commandResult).then(response => {
			if (!response.success)
				log.warn(`Failed to send ADM message '${commandResult}' to ${tx.senderId}. ${response.errorMessage}.`);
		});
		itx.update({ isProcessed: true }, true);

	} catch (e) {
		tx = tx || {};
		log.error(`Error while processing ${commandMsg} command from ${tx.recipientId} (transaction ${tx.id}). Error: ${e.toString()}`);
	}
};

function help() {
	let personalFee = [];
	let personalFeeString = '';

	config.known_crypto.forEach(c => {
		if (config['exchange_fee_' + c] !== config.exchange_fee) {
			personalFee.push(`*${c}*: *${config['exchange_fee_' + c]}%*`);
		};
	});

	if (personalFee.length) {
		personalFeeString = `In general, I take *${config.exchange_fee}%* for my work. But due to the rates fluctuation, if you send me these coins, fees differ — ` + personalFee.join(', ');
	} else {
		personalFeeString = `I take *${config.exchange_fee}%* for my work`;
	}

	let str = `I am **online** and ready for a deal. `;
	if (utils.isArraysEqual(config.accepted_crypto, config.exchange_crypto)) {
		str += `I exchange anything between *${config.accepted_crypto.join(', ')}*. `
	} else {
		str += `I accept *${config.accepted_crypto.join(', ')}* for exchange to *${config.exchange_crypto.join(', ')}*. `
	}

	str += `${personalFeeString}. I accept minimal equivalent of *${config.min_value_usd}* USD. Your daily limit is *${config.daily_limit_usd}* USD. Usually I wait for *${config.min_confirmations}* block confirmations for income transactions, but some coins may have different value.`;

	return str + `

I understand commands:

**/rates** — I will provide market exchange rates for specific coin. F. e., */rates ADM* or */rates USD*.

**/calc** — I will calculate one coin value in another using market exchange rates. Works like this: */calc 2.05 BTC in USD*.

**/balances** — I will show my crypto balances. Don’t request exchange if I don’t have enough balance for coin you need.

**/test** — I will estimate and test exchange request. Do it before each exchange. Works like this: */test 0.35 ETH to ADM*. So you’ll know how much you’ll receive in return. I will pay blockchain fees by myself.

**To make an exchange**, just send me crypto here in-Chat and comment with crypto ticker you want to get back. F. e., if you want to exchange 0.35 ETH for ADM, send in-Chat payment of 0.35 ETH to me with “ADM” comment.
`;
}

async function rates(params) {

	const coin = (params[0] || '').toUpperCase().trim();
	if (!coin || !coin.length) {
		return 'Please specify coin ticker you are interested in. F. e., */rates ADM*.';
	}

	if (!exchangerUtils.isHasTicker(coin)) {
		return `I don’t have rates of crypto *${coin}* from Infoservice.`;
	}

	const result = Object
		.keys(Store.currencies)
		.filter(t => t.startsWith(coin + '/'))
		.map(t => {
			let quoteCoin = t.replace(coin + '/', '');
			let pair = `${coin}/**${quoteCoin}**`;
			let rate = utils.formatNumber(Store.currencies[t].toFixed(constants.PRECISION_DECIMALS));
			return `${pair}: ${rate}`;
		})
		.join(', ');

	if (!result || !result.length) {
		return `I can’t get rates for *${coin}*. Try */rates ADM*.`;
	}

	return `Market rates:\n${result}.`;

}

function calc(params) {

	if (params.length !== 4) {
		return 'Wrong arguments. Command works like this: */calc 2.05 BTC in USD*.';
	}

	const amount = +params[0];
	const inCurrency = params[1].toUpperCase().trim();
	const outCurrency = params[3].toUpperCase().trim();

	if (!utils.isPositiveOrZeroNumber(amount)) {
		return `Wrong amount: _${params[0]}_. Command works like this: */calc 2.05 BTC in USD*.`;
	}
	if (!exchangerUtils.isHasTicker(inCurrency)) {
		return `I don’t have rates of crypto *${inCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USD*.`;
	}
	if (!exchangerUtils.isHasTicker(outCurrency)) {
		return `I don’t have rates of crypto *${outCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USD*.`;
	}

	let result = Store.convertCryptos(inCurrency, outCurrency, amount).outAmount;

	if (!utils.isPositiveOrZeroNumber(result)) {
		return `Unable to calc _${params[0]}_ ${inCurrency} in *${outCurrency}*.`;
	}

	let precision = exchangerUtils.isFiat(outCurrency) ? 2 : constants.PRECISION_DECIMALS;

	return `Market value of ${utils.formatNumber(amount)} ${inCurrency} equals ${utils.formatNumber(result.toFixed(precision), true)} ${outCurrency}.`;
}

async function test(arr, tx) {
	if (arr.length !== 4) { // error request
		return 'Wrong arguments. Command works like this: */test 0.35 ETH to ADM*.';
	}

	const amount = +arr[0];
	const inCurrency = arr[1].toUpperCase().trim();
	const outCurrency = arr[3].toUpperCase().trim();
	const { accepted_crypto, exchange_crypto, daily_limit_usd } = config;

	if (!amount || amount === Infinity) {
		return `It seems amount "*${amount}*" for *${inCurrency}* is not a number. Command works like this: */test 0.35 ETH to ADM*.`;
	}
	if (!exchangerUtils.isKnown(inCurrency)) {
		return `I don’t work with crypto *${inCurrency}*. Command works like this: */test 0.35 ETH to ADM*.`;
	}
	if (!exchangerUtils.isKnown(outCurrency)) {
		return `I don’t work with crypto *${outCurrency}*. Command works like this: */test 0.35 ETH to ADM*.`;
	}
	if (!exchangerUtils.isHasTicker(inCurrency)) {
		return `I don’t have rates of crypto *${outCurrency}* from Infoservice. Made a typo? Try */test 0.35 ETH to ADM*.`;
	}
	if (!exchangerUtils.isHasTicker(outCurrency)) {
		return `I don’t have rates of crypto *${outCurrency}* from Infoservice. Made a typo? Try */test 0.35 ETH to ADM*.`;
	}
	if (!exchangerUtils.isExchanged(inCurrency)) {
		return `Crypto *${inCurrency}* is not accepted. I accept *${accepted_crypto.join(', ')}* and exchange to *${exchange_crypto.join(', ')}*.`;
	}
	if (!exchangerUtils.isAccepted(outCurrency)) {
		return `I don’t exchange to *${outCurrency}*. I accept *${accepted_crypto.join(', ')}* and exchange to *${exchange_crypto.join(', ')}*.`;
	}
	if (inCurrency === outCurrency) {
		return `Do you really want to exchange *${inCurrency}* for *${outCurrency}*? You are kidding!`;
	}

	let result = Store.convertCryptos(inCurrency, outCurrency, amount, true).outAmount;
	if (amount <= 0 || result <= 0 || !result) {
		return `I didn’t understand amount for *${inCurrency}*. Command works like this: */test 0.35 ETH to ADM*.`;
	}

	const usdEqual = Store.convertCryptos(inCurrency, 'USD', amount).outAmount;
	if (usdEqual < config['min_value_usd_' + inCurrency]) {
		return `I don’t accept exchange of crypto below minimum value of *${config['min_value_usd_' + inCurrency]}* USD. Exchange more coins.`;
	}
	if (tx) {
		const userDailyValue = await exchangerUtils.userDailyValue(tx.senderId);
		if (userDailyValue >= daily_limit_usd) {
			return `You have exceeded maximum daily volume of *${daily_limit_usd}* USD. Come back tomorrow.`;
		} else if (userDailyValue + usdEqual >= daily_limit_usd) {
			return `This exchange will exceed maximum daily volume of *${daily_limit_usd}* USD. Exchange less coins.`;
		}
	}

	let etherString = '';
	let isNotEnoughBalance;

	if (exchangerUtils.isERC20(outCurrency)) {
		isNotEnoughBalance = (result > exchangerUtils[outCurrency].balance) || (exchangerUtils[outCurrency].FEE > exchangerUtils['ETH'].balance);
		if (exchangerUtils[outCurrency].FEE > exchangerUtils['ETH'].balance) {
			etherString = `Not enough Ether to pay fees. `;
		}
	} else {
		etherString = '';
		isNotEnoughBalance = result + exchangerUtils[outCurrency].FEE > exchangerUtils[outCurrency].balance;
	}


	if (isNotEnoughBalance) {
		return `I have not enough coins to send *${result}* *${outCurrency}* for exchange. ${etherString}Check my balances with **/balances** command.`;
	}

	return `Ok. Let's make a bargain. I’ll give you *${result}* *${outCurrency}*. To proceed, send me *${amount}* *${inCurrency}* here In-Chat with comment "${outCurrency}". Don’t write anything else in comment, otherwise I will send transfer back to you. And hurry up, while exchange rate is so good!`;
}

function balances() {
	return config.exchange_crypto.reduce((result, crypto) => {
		return result + `\n${utils.formatNumber(+exchangerUtils[crypto].balance.toFixed(constants.PRECISION_DECIMALS), true)} _${crypto}_`;
	}, 'My crypto balances:');
}

function version() {
	return `I am running on _adamant-exchangebot_ software version _${config.version}_. Revise code on ADAMANT's GitHub.`;
}

const commands = {
	help,
	rates,
	calc,
	balances,
	test,
	version
};
