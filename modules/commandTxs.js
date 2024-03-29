const constants = require('../helpers/const');
const config = require('./configReader');
const log = require('../helpers/log');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const api = require('./api');

module.exports = async (commandMsg, tx, itx) => {
  try {

    log.log(`Processing '${commandMsg}' command from ${tx.senderId} (transaction ${tx.id})…`);
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
      commandResult = await command(group, tx, itx ? itx.commandFix : undefined);
    } else {
      commandResult = `I don’t know */${commandName}* command. ℹ️ You can start with **/help**.`;
    }

    api.sendMessage(config.passPhrase, tx.senderId, commandResult).then((response) => {
      if (!response.success) {
        log.warn(`Failed to send ADM message '${commandResult}' to ${tx.senderId}. ${response.errorMessage}.`);
      }
    });
    itx.update({ isProcessed: true }, true);

  } catch (e) {
    tx = tx || {};
    log.error(`Error while processing ${commandMsg} command from ${tx.senderId} (transaction ${tx.id}). Error: ${e.toString()}`);
  }
};

function help({}, {}, commandFix) {

  const specialFees = [];
  let oneSpecialFeeCoin = '';
  let oneSpecialFeeRate = '';

  const fixedFees = [];
  const specialDailyLimits = [];

  let feesString = '';

  // Special fees in %
  config.known_crypto.forEach((coin) => {
    if (config['exchange_fee_' + coin] !== config.exchange_fee) {
      specialFees.push(`*${coin}*: *${config['exchange_fee_' + coin]}%*`);
      oneSpecialFeeCoin = coin;
      oneSpecialFeeRate = `${config['exchange_fee_' + coin]}%`;
    };
  });

  // Fixed fees in USD
  config.known_crypto.forEach((coin) => {
    if (config['fixed_buy_price_usd_' + coin] ||config['fixed_sell_price_usd_' + coin]) {
      let fixedFeeString = `*${coin}*: `;
      let isBuyPrice = false;
      if (config['fixed_buy_price_usd_' + coin]) {
        fixedFeeString += `buying at ${config['fixed_buy_price_usd_' + coin]} USD`;
        isBuyPrice = true;
      }
      if (config['fixed_sell_price_usd_' + coin]) {
        if (isBuyPrice) fixedFeeString += ', ';
        fixedFeeString += `selling at ${config['fixed_sell_price_usd_' + coin]} USD`;
      }
      fixedFees.push(fixedFeeString);
    };
  });

  if (specialFees.length === 1) {
    feesString = `I take *${config.exchange_fee}%* fee, plus you pay blockchain Tx fees. Due to the rates fluctuation, I take ${oneSpecialFeeRate} fee, if you send me ${oneSpecialFeeCoin}`;
  } else if (specialFees.length) {
    feesString = `In general, I take *${config.exchange_fee}%* fee, plus you pay blockchain Tx fees. But due to the rates fluctuation, if you send me these coins, fees differ — ` + specialFees.join(', ');
  } else {
    feesString = `I take *${config.exchange_fee}%* fee, plus you pay blockchain Tx fees`;
  }

  if (fixedFees.length) {
    feesString += `. Fixed rates not including fees — ${fixedFees.join(', ')}`;
  }

  const minValueString = config.min_value_usd ? ` I accept minimal exchange of *${config.min_value_usd}* USD equivalent.` : '';

  let result = `I am **online** and ready for a deal. `;
  result += exchangerUtils.iAcceptAndExchangeString + '. ';
  result += `${feesString}.${minValueString}`;

  if (config.daily_limit_show) {
    result += ` Your daily exchange limit is *${config.daily_limit_usd}* USD`;
    config.known_crypto.forEach((coin) => {
      const coinDailyLimit = config['daily_limit_usd_' + coin];
      if (coinDailyLimit !== config.daily_limit_usd) {
        specialDailyLimits.push(`${coin}: ${coinDailyLimit ? coinDailyLimit + ' USD' : 'no limit' }`);
      };
    });
    if (specialDailyLimits.length) {
      result += ` (buying ${specialDailyLimits.join(', ')}).`;
    } else {
      result += '.';
    }
  }

  result += `\n\nI understand commands:`;
  result += `\n\n**/rates** — show market rates for specific coin. F. e., */rates ADM*.`;
  result += `\n\n**/calc** — calculate one coin value in another using market rates. Works like this: */calc 2.05 BTC in USD*.`;
  result += `\n\n**/balances** — show my crypto balances. Don’t request an exchange if I don’t have enough coins.`;
  result += `\n\n**/test** — test exchange request and estimate return value. Do it before each exchange. Works like this: */test 0.35 ETH to ADM*.`;
  result += `\n\n**To make an exchange**, send me crypto you want to exchange here in-Chat.`;

  if (commandFix === 'help') {
    result += `\n\nNote: commands starts with slash **/**. Example: **/help**.`;
  }

  return result;

}

async function rates(params) {

  const coin = (params[0] || '').toUpperCase().trim();
  if (!coin || !coin.length) {
    return 'Please specify coin ticker you are interested in. F. e., */rates ADM*.';
  }

  if (!exchangerUtils.hasTicker(coin)) {
    return `I don’t have rates of crypto *${coin}* from Infoservice.`;
  }

  const result = Object
      .keys(exchangerUtils.currencies)
      .filter((t) => t.startsWith(coin + '/'))
      .map((t) => {
        const quoteCoin = t.replace(coin + '/', '');
        const pair = `${coin}/**${quoteCoin}**`;
        const rate = utils.formatNumber(exchangerUtils.currencies[t].toFixed(constants.PRECISION_DECIMALS));
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
  if (!exchangerUtils.hasTicker(inCurrency)) {
    return `I don’t have rates of crypto *${inCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USD*.`;
  }
  if (!exchangerUtils.hasTicker(outCurrency)) {
    return `I don’t have rates of crypto *${outCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USD*.`;
  }

  const result = exchangerUtils.convertCryptos(inCurrency, outCurrency, amount).outAmount;

  if (!utils.isPositiveOrZeroNumber(result)) {
    return `Unable to calc _${params[0]}_ ${inCurrency} in ${outCurrency}.`;
  }

  const precision = exchangerUtils.isFiat(outCurrency) ? 2 : constants.PRECISION_DECIMALS;

  return `Market value of ${utils.formatNumber(amount)} ${inCurrency} equals ${utils.formatNumber(result.toFixed(precision), true)} ${outCurrency}.`;
}

async function test(params, tx) {

  if (params.length !== 4) {
    return 'Wrong arguments. Command works like this: */test 0.35 ETH to ADM*.';
  }

  const amount = +params[0];
  const inCurrency = params[1].toUpperCase().trim();
  const outCurrency = params[3].toUpperCase().trim();

  if (!utils.isPositiveOrZeroNumber(amount)) {
    return `Wrong amount: _${params[0]}_. Command works like this: */test 0.35 ETH to ADM*.`;
  }

  if (!exchangerUtils.hasTicker(outCurrency)) {
    return `I don’t have rates of crypto *${outCurrency}* from Infoservice. Made a typo? Try */test 0.35 ETH to ADM*.`;
  }

  if (!exchangerUtils.isAccepted(inCurrency)) {
    return `I don't accept *${inCurrency}*. ${exchangerUtils.iAcceptAndExchangeString}.`;
  }

  if (!exchangerUtils.isExchanged(outCurrency)) {
    return `I don’t exchange to *${outCurrency}*. ${exchangerUtils.iAcceptAndExchangeString}.`;
  }

  if (inCurrency === outCurrency) {
    return `Do you really want to exchange *${inCurrency}* for *${outCurrency}*? You are kidding!`;
  }

  const usdEqual = exchangerUtils.convertCryptos(inCurrency, 'USD', amount).outAmount;
  if (usdEqual < config.min_value_usd) {
    return `Minimum value for exchange is *${config.min_value_usd}* USD, but ${amount} ${inCurrency} is ~${usdEqual} USD. Exchange more coins.`;
  }

  const result = exchangerUtils.convertCryptos(inCurrency, outCurrency, amount, true).outAmount;
  if (!result) {
    return `Unable to calculate exchange value of _${params[0]}_ ${inCurrency} to ${outCurrency}.`;
  }
  if (!utils.isPositiveNumber(result)) {
    return `_${params[0]}_ ${inCurrency} doesn't cover network Tx fee of ${exchangerUtils[outCurrency].FEE} ${exchangerUtils.isERC20(outCurrency) ? 'ETH' : outCurrency}. Exchange more coins.`;
  }

  if (tx) {
    const userDailyValue = await exchangerUtils.userDailyValue(tx.senderId);
    const userDailyLimit = config['daily_limit_usd_' + outCurrency] || undefined; // 0 is 'undefined', means no limit
    if (userDailyValue >= userDailyLimit) {
      return `You have exceeded maximum daily volume of *${userDailyLimit}* USD. Come back tomorrow.`;
    } else if (userDailyValue + usdEqual >= userDailyLimit) {
      return `This exchange will exceed maximum daily volume of *${userDailyLimit}* USD. Exchange less coins.`;
    }
  }

  let etherString = '';
  let isNotEnoughBalance;

  const outCurrencyBalance = await exchangerUtils[outCurrency].getBalance();
  if (exchangerUtils.isERC20(outCurrency)) {
    const ethBalance = await exchangerUtils['ETH'].getBalance();
    isNotEnoughBalance = (result > outCurrencyBalance) || (exchangerUtils[outCurrency].FEE > ethBalance);
    if (exchangerUtils[outCurrency].FEE > ethBalance) {
      etherString = `Not enough Ether to pay fees. `;
    }
  } else {
    etherString = '';
    isNotEnoughBalance = result + exchangerUtils[outCurrency].FEE > outCurrencyBalance;
  }

  if (isNotEnoughBalance) {
    return `I have not enough coins to send *${result}* *${outCurrency}* for exchange. ${etherString}Check my balances with **/balances** command.`;
  }

  // Calculating min and max price to buy and sell
  const inCurrencyPriceUsd = exchangerUtils.getRate(inCurrency, 'USD');
  const outCurrencyPriceUsd = exchangerUtils.getRate(outCurrency, 'USD');
  const maxInCurrencyBuyPriceUsd = config['max_buy_price_usd_' + inCurrency];
  const minOutCurrencySellPriceUsd = config['min_sell_price_usd_' + outCurrency];

  if (maxInCurrencyBuyPriceUsd && inCurrencyPriceUsd > maxInCurrencyBuyPriceUsd) { // Check for 'max_buy_price_usd'
    return `${inCurrency} rate currently is ${inCurrencyPriceUsd} USD and it's too high. I'll abstain from buying it now because of a possible rates fluctuation. Try again later.`;
  }

  if (minOutCurrencySellPriceUsd && outCurrencyPriceUsd < minOutCurrencySellPriceUsd) { // Check for 'min_sell_price_usd'
    return `${outCurrency} rate currently is ${outCurrencyPriceUsd} USD and it's too low. I'll abstain from selling it now because of a possible rates fluctuation. Try again later.`;
  }

  return `Ok. Let's make a bargain! I’ll give you ~ *${result}* *${outCurrency}* (valid for this moment, depends on market rate). To proceed, send me *${amount}* *${inCurrency}* here In-Chat.`;

}

async function balances() {
  await exchangerUtils.refreshExchangedBalances();
  return config.exchange_crypto.reduce((result, crypto) => {
    const cryptoBalance = exchangerUtils[crypto].balance;
    const balanceString = `\n${utils.isPositiveOrZeroNumber(cryptoBalance) ? utils.formatNumber(cryptoBalance.toFixed(constants.PRECISION_DECIMALS), true) : '?'} _${crypto}_`;
    return result + balanceString;
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
  version,
};
