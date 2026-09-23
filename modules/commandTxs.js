const constants = require('../helpers/const');
const config = require('./configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const utils = require('../helpers/utils');
const messenger = require('../helpers/messenger');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const db = require('./DB');
const { withSenderLock } = require('../helpers/mutex');

/**
 * Builds the `/help` reply: what the bot is, what it charges, what it limits, and
 * which commands it understands.
 *
 * @param {string[]} _params Command arguments; `/help` takes none
 * @param {object} _tx ADAMANT transaction
 * @param {string} [commandFix] Set when the user's message was auto-corrected into a command
 * @returns {string}
 */
function help(_params, _tx, commandFix) {
  const specialFees = [];
  const fixedPrices = [];
  const specialDailyLimits = [];

  let oneSpecialFeeCoin = '';
  let oneSpecialFeeRate = '';

  for (const coin of config.known_crypto) {
    if (config[`exchange_fee_${coin}`] !== config.exchange_fee) {
      specialFees.push(`*${coin}*: *${config[`exchange_fee_${coin}`]}%*`);
      oneSpecialFeeCoin = coin;
      oneSpecialFeeRate = `${config[`exchange_fee_${coin}`]}%`;
    }
  }

  for (const coin of config.known_crypto) {
    const buyPrice = config[`fixed_buy_price_usd_${coin}`];
    const sellPrice = config[`fixed_sell_price_usd_${coin}`];

    if (!buyPrice && !sellPrice) {
      continue;
    }

    const parts = [];

    if (buyPrice) parts.push(`buying at ${buyPrice} USD`);
    if (sellPrice) parts.push(`selling at ${sellPrice} USD`);

    fixedPrices.push(`*${coin}*: ${parts.join(', ')}`);
  }

  let feesString;

  if (specialFees.length === 1) {
    feesString = `I take a *${config.exchange_fee}%* fee, and you pay the blockchain Tx fees on top. Because rates fluctuate, I take a ${oneSpecialFeeRate} fee if you send me ${oneSpecialFeeCoin}`;
  } else if (specialFees.length) {
    feesString = `In general I take a *${config.exchange_fee}%* fee, and you pay the blockchain Tx fees on top. Because rates fluctuate, the fee differs for some coins — ${specialFees.join(', ')}`;
  } else {
    feesString = `I take a *${config.exchange_fee}%* fee, and you pay the blockchain Tx fees on top`;
  }

  if (fixedPrices.length) {
    feesString += `. Fixed rates, not including fees — ${fixedPrices.join(', ')}`;
  }

  const minValueString = config.min_value_usd
    ? ` The minimum exchange I accept is *${config.min_value_usd}* USD equivalent.`
    : '';

  let result = 'I am **online** and ready for a deal. ';

  result += `${exchangerUtils.iAcceptAndExchangeString}. `;
  result += `${feesString}.${minValueString}`;

  if (config.daily_limit_show) {
    result += ` Your daily exchange limit is *${config.daily_limit_usd}* USD`;

    for (const coin of config.known_crypto) {
      const coinDailyLimit = config[`daily_limit_usd_${coin}`];

      if (coinDailyLimit !== config.daily_limit_usd) {
        specialDailyLimits.push(`${coin}: ${coinDailyLimit ? `${coinDailyLimit} USD` : 'no limit'}`);
      }
    }

    result += specialDailyLimits.length ? ` (buying ${specialDailyLimits.join(', ')}).` : '.';
  }

  result += '\n\nI understand these commands:';
  result += '\n\n**/rates** — show market rates for a coin. For example, */rates ADM*.';
  result += '\n\n**/calc** — convert one coin into another at market rates. For example, */calc 2.05 BTC in USD*.';
  result += '\n\n**/balances** — show my balances. Don’t request an exchange if I don’t have enough coins.';
  result +=
    '\n\n**/test** — dry-run an exchange request and see the estimated return. Do this before every exchange. For example, */test 0.35 ETH to ADM*.';
  result += '\n\n**/cancel** — cancel a pending exchange awaiting clarification and request a refund.';
  result += '\n\n**/version** — show which version of the software I run on.';
  result += '\n\n**To make an exchange**, send me the coin you want to exchange here in chat.';

  if (commandFix === 'help' || commandFix === 'cancel') {
    result += `\n\nNote: every command starts with a slash **/**. For example, **/${commandFix}**.`;
  }

  return result;
}

/**
 * Shows market rates for a coin.
 *
 * @param {string[]} params Command arguments; the first is the ticker
 * @returns {string}
 */
function rates(params) {
  const coin = (params[0] || '').toUpperCase().trim();

  if (!coin) {
    return 'Please specify the coin ticker you are interested in. For example, */rates ADM*.';
  }

  if (!exchangerUtils.hasTicker(coin)) {
    return `I don’t have rates for the coin *${coin}* from the InfoService.`;
  }

  const result = Object.keys(exchangerUtils.currencies)
    .filter((pair) => pair.startsWith(`${coin}/`))
    .map((pair) => {
      const quoteCoin = pair.replace(`${coin}/`, '');
      const rate = utils.formatNumber(exchangerUtils.currencies[pair].toFixed(constants.PRECISION_DECIMALS));

      return `${coin}/**${quoteCoin}**: ${rate}`;
    })
    .join(', ');

  if (!result) {
    return `I can’t get rates for *${coin}*. Try */rates ADM*.`;
  }

  return `Market rates:\n${result}.`;
}

/**
 * Converts an amount from one coin into another at market rates.
 *
 * @param {string[]} params Command arguments, as in `2.05 BTC in USD`
 * @returns {string}
 */
function calc(params) {
  const usage = 'The command works like this: */calc 2.05 BTC in USD*.';

  if (params.length !== 4) {
    return `Wrong arguments. ${usage}`;
  }

  const amount = Number(params[0]);
  const inCurrency = params[1].toUpperCase().trim();
  const outCurrency = params[3].toUpperCase().trim();

  if (!utils.isPositiveOrZeroNumber(amount)) {
    return `Wrong amount: _${params[0]}_. ${usage}`;
  }

  if (!exchangerUtils.hasTicker(inCurrency)) {
    return `I don’t have rates for the coin *${inCurrency}* from the InfoService. A typo? Try */calc 2.05 BTC in USD*.`;
  }

  if (!exchangerUtils.hasTicker(outCurrency)) {
    return `I don’t have rates for the coin *${outCurrency}* from the InfoService. A typo? Try */calc 2.05 BTC in USD*.`;
  }

  const result = exchangerUtils.convertCryptos(inCurrency, outCurrency, amount).outAmount;

  if (!utils.isPositiveOrZeroNumber(result)) {
    return `Unable to convert _${params[0]}_ ${inCurrency} into ${outCurrency}.`;
  }

  const precision = exchangerUtils.isFiat(outCurrency) ? 2 : constants.PRECISION_DECIMALS;

  return `The market value of ${utils.formatNumber(amount)} ${inCurrency} is ${utils.formatNumber(result.toFixed(precision), true)} ${outCurrency}.`;
}

/**
 * Dry-runs an exchange request: the same checks the real request goes through,
 * without moving any funds.
 *
 * @param {string[]} params Command arguments, as in `0.35 ETH to ADM`
 * @param {object} [tx] ADAMANT transaction, used to check the user's daily limit
 * @returns {Promise<string>}
 */
async function test(params, tx) {
  const usage = 'The command works like this: */test 0.35 ETH to ADM*.';

  if (params.length !== 4) {
    return `Wrong arguments. ${usage}`;
  }

  const amount = Number(params[0]);
  const inCurrency = params[1].toUpperCase().trim();
  const outCurrency = params[3].toUpperCase().trim();

  if (!utils.isPositiveOrZeroNumber(amount)) {
    return `Wrong amount: _${params[0]}_. ${usage}`;
  }

  if (!exchangerUtils.hasTicker(outCurrency)) {
    return `I don’t have rates for the coin *${outCurrency}* from the InfoService. A typo? ${usage}`;
  }

  if (!exchangerUtils.isAccepted(inCurrency)) {
    return `I don’t accept *${inCurrency}*. ${exchangerUtils.iAcceptAndExchangeString}.`;
  }

  if (!exchangerUtils.isExchanged(outCurrency)) {
    return `I don’t exchange to *${outCurrency}*. ${exchangerUtils.iAcceptAndExchangeString}.`;
  }

  if (inCurrency === outCurrency) {
    return `Do you really want to exchange *${inCurrency}* for *${outCurrency}*? You must be joking!`;
  }

  const usdEqual = exchangerUtils.convertCryptos(inCurrency, 'USD', amount).outAmount;

  if (usdEqual < config.min_value_usd) {
    return `The minimum exchange value is *${config.min_value_usd}* USD, and ${amount} ${inCurrency} is about ${usdEqual} USD. Exchange more coins.`;
  }

  const result = exchangerUtils.convertCryptos(inCurrency, outCurrency, amount, true).outAmount;
  const feeCurrency = exchangerUtils.isERC20(outCurrency) ? 'ETH' : outCurrency;

  if (!result || Number.isNaN(result)) {
    return `Unable to calculate the exchange value of _${params[0]}_ ${inCurrency} in ${outCurrency}.`;
  }

  if (!utils.isPositiveNumber(result)) {
    return `_${params[0]}_ ${inCurrency} doesn’t cover the network Tx fee of ${exchangerUtils[outCurrency].FEE} ${feeCurrency}. Exchange more coins.`;
  }

  if (tx) {
    const userDailyValue = await exchangerUtils.userDailyValue(tx.senderId);
    // 0 means "no limit".
    const userDailyLimit = config[`daily_limit_usd_${outCurrency}`] || undefined;

    if (userDailyLimit && userDailyValue >= userDailyLimit) {
      return `You have exceeded the maximum daily volume of *${userDailyLimit}* USD. Come back tomorrow.`;
    }

    if (userDailyLimit && userDailyValue + usdEqual >= userDailyLimit) {
      return `This exchange would exceed the maximum daily volume of *${userDailyLimit}* USD. Exchange fewer coins.`;
    }
  }

  const outCurrencyBalance = await exchangerUtils[outCurrency].getBalance();

  let etherString = '';
  let isNotEnoughBalance;

  if (exchangerUtils.isERC20(outCurrency)) {
    const ethBalance = await exchangerUtils.ETH.getBalance();

    isNotEnoughBalance = result > outCurrencyBalance || exchangerUtils[outCurrency].FEE > ethBalance;

    if (exchangerUtils[outCurrency].FEE > ethBalance) {
      etherString = 'I don’t have enough Ether to pay the fees. ';
    }
  } else {
    isNotEnoughBalance = result + exchangerUtils[outCurrency].FEE > outCurrencyBalance;
  }

  if (isNotEnoughBalance) {
    return `I don’t have enough coins to send you *${result}* *${outCurrency}*. ${etherString}Check my balances with the **/balances** command.`;
  }

  const inCurrencyPriceUsd = exchangerUtils.getRate(inCurrency, 'USD');
  const outCurrencyPriceUsd = exchangerUtils.getRate(outCurrency, 'USD');
  const maxInCurrencyBuyPriceUsd = config[`max_buy_price_usd_${inCurrency}`];
  const minOutCurrencySellPriceUsd = config[`min_sell_price_usd_${outCurrency}`];

  if (maxInCurrencyBuyPriceUsd && inCurrencyPriceUsd > maxInCurrencyBuyPriceUsd) {
    return `${inCurrency} currently trades at ${inCurrencyPriceUsd} USD, which is too high. I’ll hold off buying it because the rate may swing. Try again later.`;
  }

  if (minOutCurrencySellPriceUsd && outCurrencyPriceUsd < minOutCurrencySellPriceUsd) {
    return `${outCurrency} currently trades at ${outCurrencyPriceUsd} USD, which is too low. I’ll hold off selling it because the rate may swing. Try again later.`;
  }

  return `OK, let’s make a deal! I’ll give you about *${result}* *${outCurrency}* — valid right now, it depends on the market rate. To proceed, send me *${amount}* *${inCurrency}* here in chat.`;
}

/**
 * Shows the bot's balances for every coin it pays out in.
 *
 * @returns {Promise<string>}
 */
async function balances() {
  await exchangerUtils.refreshExchangedBalances();

  return config.exchange_crypto.reduce((result, coin) => {
    const balance = exchangerUtils[coin].balance;
    const formatted = utils.isPositiveOrZeroNumber(balance)
      ? utils.formatNumber(balance.toFixed(constants.PRECISION_DECIMALS), true)
      : '?';

    return `${result}\n${formatted} _${coin}_`;
  }, 'My balances:');
}

/**
 * Shows the running software version.
 *
 * @returns {string}
 */
function version() {
  return `I run on _adamant-exchangebot_ software version _${config.version}_. Review the code on ADAMANT’s GitHub.`;
}

/**
 * Cancels an exchange awaiting clarification and queues it for refund.
 *
 * @param {string[]} _params Command arguments; `/cancel` takes none
 * @param {object} tx ADAMANT transaction
 * @returns {Promise<string>}
 */
async function cancel(_params, tx) {
  return withSenderLock(tx.senderId, async () => {
    const pendingPayments = (
      await db.paymentsDb.find({
        senderId: tx.senderId,
        inUpdateState: { $nin: [null, undefined] },
        needToSendBack: { $ne: true },
      })
    ).filter((payment) => utils.isAwaitingClarification(payment));

    if (!pendingPayments.length) {
      return 'You don’t have any pending exchange awaiting clarification to cancel.';
    }

    for (const payment of pendingPayments) {
      await payment.update(
        {
          needToSendBack: true,
          isBasicChecksPassed: true,
          inUpdateState: undefined,
        },
        true,
      );

      const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${payment.admTxId ?? payment._id} from ${payment.senderId}`;

      notify(
        `${config.notifyName} cancelled the pending exchange of _${payment.inAmountMessage}_ _${payment.inCurrency}_ by user request. Will try to send the payment back. ${admTxDescription}.`,
        'info',
      );
    }

    const first = pendingPayments[0];
    const minConfirmations = config[`min_confirmations_${first.inCurrency}`] ?? config.min_confirmations;

    return (
      `I’ve cancelled your exchange of _${first.inAmountMessage}_ _${first.inCurrency}_. ` +
      `I’ll validate the transfer and send it back to you once it gets _${minConfirmations}_ block confirmations. ` +
      'Note that some of it will cover blockchain fees.'
    );
  });
}

/** Commands the bot answers, keyed by name without the leading slash. */
const commands = {
  help,
  rates,
  calc,
  balances,
  test,
  version,
  cancel,
};

/**
 * Runs a command from a chat message and replies to the user.
 *
 * @param {string} commandMsg Decrypted message, starting with a slash
 * @param {object} tx ADAMANT transaction
 * @param {object} itx Stored incoming transaction
 * @returns {Promise<void>}
 */
module.exports = async (commandMsg, tx, itx) => {
  try {
    log.log(`Processing the '${commandMsg}' command from ${tx.senderId} (transaction ${tx.id})…`);

    const group = commandMsg.trim().split(/\s+/);
    const commandName = group.shift().trim().toLowerCase().replace(/^\//, '');
    const command = commands[commandName];

    const commandResult = command
      ? await command(group, tx, itx?.commandFix)
      : `I don’t know the */${commandName}* command. ℹ️ You can start with **/help**.`;

    await messenger.sendMessage(tx.senderId, commandResult);
    await itx.update({ isProcessed: true }, true);
  } catch (error) {
    log.error(
      `Error while processing the ${commandMsg} command from ${tx?.senderId} (transaction ${tx?.id}). ${error}`,
    );
  }
};

module.exports.commands = commands;
