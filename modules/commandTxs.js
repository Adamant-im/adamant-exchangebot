const Store = require('../modules/Store');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const config = require('./configReader');
const log = require('../helpers/log');

module.exports = async (cmd, tx, itx) => {
	log.info('Got new Command Tx to process: ' + cmd);
	try {
		let msg = '';
		const group = cmd
			.trim()
			.replace(/    /g, ' ')
			.replace(/   /g, ' ')
			.replace(/  /g, ' ')
			.split(' ');
		const methodName = group.shift().trim().toLowerCase().replace('\/', '');
		const m = commands[methodName];
		if (m){
			msg = await m(group, tx);
		} else {
			msg = `I don’t know */${methodName}* command. ℹ️ You can start with **/help**.`;
		}
		if (!tx){
			return msg;
		}
		if (tx){
			exchangerUtils.sendAdmMsg(tx.senderId, msg);
			itx.update({isProcessed: true}, true);
		}
	} catch (e){
		tx = tx || {};
		log.error('Error while processing command ' + cmd + ' from sendedId ' + tx.senderId + '. Tx Id: ' + tx.id + '. Error: ' + e);
	}
};

function help() {
	let personalFee = [];
	let personalFeeString = '';

	config.known_crypto.forEach(c=>{
		if (config['exchange_fee_' + c] !== config.exchange_fee){
			personalFee.push(`*${c}*: *${config['exchange_fee_' + c]}%*`);
		};
	});

	if (personalFee.length){
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

async function rates(arr) {
	const coin = (arr[0] || '').toUpperCase().trim();
	if (!coin || !coin.length){
		return 'Please specify coin ticker you are interested in. F. e., */rates ADM*.';
	}
	const currencies = Store.currencies;
	const res = Object
		.keys(Store.currencies)
		.filter(t => t.startsWith(coin + '/'))
		.map(t => {
			let pair = `${coin}/**${t.replace(coin + '/', '')}**`;
			return `${pair}: ${currencies[t]}`;
		})
		.join(', ');

	if (!res.length){
		return `I can’t get rates for *${coin}*. Made a typo? Try */rates ADM*.`;
	}
	return `Market rates:
	${res}.`;
}

function calc(arr) {
	if (arr.length !== 4) { // error request
		return 'Wrong arguments. Command works like this: */calc 2.05 BTC in USD*.';
	}

	const amount = +arr[0];
	const inCurrency = arr[1].toUpperCase().trim();
	const outCurrency = arr[3].toUpperCase().trim();

	if (!amount || amount === Infinity){
		return `It seems amount "*${amount}*" for *${inCurrency}* is not a number. Command works like this: */calc 2.05 BTC in USD*.`;
	}
	if (!exchangerUtils.isHasTicker(inCurrency)) {
		return `I don’t have rates of crypto *${inCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USD*.`;
	}
	if (!exchangerUtils.isHasTicker(outCurrency)) {
		return `I don’t have rates of crypto *${outCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USD*.`;
	}
	let result = Store.mathEqual(inCurrency, outCurrency, amount, true).outAmount;

	if (amount <= 0 || result <= 0 || !result) {
		return `I didn’t understand amount for *${inCurrency}*. Command works like this: */calc 2.05 BTC in USD*.`;
	}
	if (exchangerUtils.isFiat(outCurrency)) {
		result = +result.toFixed(2);
	}
	return `Market value of ${utils.thousandSeparator(amount)} ${inCurrency} equals **${utils.thousandSeparator(result)} ${outCurrency}**.`;
}

async function test(arr, tx) {
	if (arr.length !== 4) { // error request
		return 'Wrong arguments. Command works like this: */test 0.35 ETH to ADM*.';
	}

	const amount = +arr[0];
	const inCurrency = arr[1].toUpperCase().trim();
	const outCurrency = arr[3].toUpperCase().trim();
	const {accepted_crypto, exchange_crypto, daily_limit_usd} = config;

	if (!amount || amount === Infinity){
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
	if (inCurrency === outCurrency){
		return `Do you really want to exchange *${inCurrency}* for *${outCurrency}*? You are kidding!`;
	}

	let result = Store.mathEqual(inCurrency, outCurrency, amount).outAmount;
	if (amount <= 0 || result <= 0 || !result) {
		return `I didn’t understand amount for *${inCurrency}*. Command works like this: */test 0.35 ETH to ADM*.`;
	}

	const usdEqual = Store.mathEqual(inCurrency, 'USD', amount, true).outAmount;
	if (usdEqual < config['min_value_usd_' + inCurrency]) {
		return `I don’t accept exchange of crypto below minimum value of *${config['min_value_usd_' + inCurrency]}* USD. Exchange more coins.`;
	}
	if (tx){
		const userDailyValue = await exchangerUtils.userDailyValue(tx.senderId);
		if (userDailyValue >= daily_limit_usd) {
			return `You have exceeded maximum daily volume of *${daily_limit_usd}* USD. Come back tomorrow.`;
		} else if (userDailyValue + usdEqual >= daily_limit_usd){
			return `This exchange will exceed maximum daily volume of *${daily_limit_usd}* USD. Exchange less coins.`;
		}
	}

	let etherString = '';
	let isNotEnoughBalance;
	
	if (exchangerUtils.isERC20(outCurrency)) {
		isNotEnoughBalance = (result > Store.user[outCurrency].balance) || (exchangerUtils[outCurrency].FEE > Store.user['ETH'].balance);
		if (exchangerUtils[outCurrency].FEE > Store.user['ETH'].balance) {
			etherString = `Not enough Ether to pay fees. `;
		}
	} else {
		etherString = '';				
		isNotEnoughBalance = result + exchangerUtils[outCurrency].FEE > Store.user[outCurrency].balance;
	}


	if (isNotEnoughBalance) {
		return `I have not enough coins to send *${result}* *${outCurrency}* for exchange. ${etherString}Check my balances with **/balances** command.`;
	}

	return `Ok. Let's make a bargain. I’ll give you *${result}* *${outCurrency}*. To proceed, send me *${amount}* *${inCurrency}* here In-Chat with comment "${outCurrency}". Don’t write anything else in comment, otherwise I will send transfer back to you. And hurry up, while exchange rate is so good!`;
}

function balances() {
	return config.exchange_crypto.reduce((str, c) => {
		return str + `
		${utils.thousandSeparator(+Store.user[c].balance.toFixed(8), true)} _${c}_`;
	}, 'My crypto balances:');
}

function version(){
	return `I am running on _adamant-exchangebot_ software version _${Store.version}_. Revise code on ADAMANT's GitHub.`;
}


const commands = {
	help,
	rates,
	calc,
	balances,
	test,
	version
};


// setTimeout(()=>{
// unitTest('/test 80 adm in usds');
// unitTest('/calc 100 usds in btc');
// unitTest('/calc 100 usds in usd');
// unitTest('/test Infinity BTC in USD');
// unitTest('/test 1 usds to usd');
// unitTest('/test 100 adm to usd');
// unitTest('/test 100 adm to usds');
// unitTest('/rates');
// }, 10000);

// async function unitTest(cmd){
// 	console.log('>>>', cmd, '->', await module.exports(cmd));
// }
