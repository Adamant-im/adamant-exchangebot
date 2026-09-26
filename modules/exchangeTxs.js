const db = require('./DB');
const config = require('./configReader');
const constants = require('../helpers/const');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const utils = require('../helpers/utils');
const notify = require('../helpers/notify');
const log = require('../helpers/log');
const messenger = require('../helpers/messenger');
const depositClaims = require('./depositClaims');
const { withSenderLock } = require('../helpers/mutex');

/**
 * Error codes the basic checks store with a payment.
 *
 * These values are persisted in the `payments` collection and appear in operator
 * notifications, so an existing code must never be reused for a different meaning.
 */
const BASIC_CHECK_ERRORS = {
  DUPLICATE_TX: 1,
  UNKNOWN_IN_CURRENCY: 2,
  UNACCEPTED_IN_CURRENCY: 5,
  WRONG_AMOUNT: 7,
  WRONG_REQUEST: 8,
  BELOW_MIN_VALUE: 20,
  DAILY_LIMIT_EXCEEDED: 23,
  BELOW_MIN_TRANSFER: 27,
  NO_RATES: 32,
  BUY_PRICE_TOO_HIGH: 101,
  SELL_PRICE_TOO_LOW: 102,
};

/** Characters users habitually wrap a ticker in when naming the coin they want. */
const TICKER_TRIM_CHARS = ` '",.<>()$!*-=+{}[]?/\\`;

/**
 * Reads the exchange request out of an incoming message.
 *
 * A request reaches the bot in one of three shapes: an ADM transfer whose comment
 * names the wanted coin, a rich message describing a transfer made in another
 * blockchain, or a plain message answering an earlier clarification request.
 *
 * @param {object} itx Stored incoming transaction
 * @param {object} tx ADAMANT transaction
 * @param {object} [payToUpdate] Payment that is awaiting clarification
 * @returns {{inAmountMessage: *, inCurrency: string, outCurrency: string, inTxid: *}}
 */
function parseExchangeRequest(itx, tx, payToUpdate) {
  const message = itx.decryptedMessage;

  let inAmountMessage;
  let inCurrency;
  let outCurrency;
  let inTxid;

  if (payToUpdate && payToUpdate.inUpdateState === 'outCurrency') {
    // The user is naming the coin they want for a transfer the bot already knows about.
    inAmountMessage = payToUpdate.inAmountMessage;
    inCurrency = payToUpdate.inCurrency;
    outCurrency = message;
    inTxid = payToUpdate._id;
  } else if (tx.amount > 0) {
    // An ADM transfer; the comment names the coin the user wants.
    inAmountMessage = tx.amount / constants.SAT;
    inCurrency = 'ADM';
    outCurrency = message;
    inTxid = tx.id;
  } else if (message.includes('_transaction')) {
    // A transfer in another blockchain, announced as a rich message.
    inCurrency = message.match(/"type":"(.*)_transaction/)?.[1];

    const details = utils.tryParseJSON(message);

    if (details) {
      inAmountMessage = details.amount;
      inTxid = details.hash;
      outCurrency = details.comments;
    }
  }

  return {
    inAmountMessage,
    inCurrency: String(inCurrency).toUpperCase().trim(),
    outCurrency: utils.trimAny(outCurrency, TICKER_TRIM_CHARS).toUpperCase(),
    inTxid,
  };
}

/**
 * Builds the detailed rate description the operator receives.
 *
 * Shows both sides of the deal in USD and, where it is not the quote coin itself,
 * in BTC — an operator reading a notification needs to see at a glance whether the
 * deal was priced sensibly.
 *
 * @param {object} pay Payment document
 * @param {string} inCurrency Ticker the bot receives
 * @param {string} outCurrency Ticker the bot sends
 * @returns {string}
 */
function formRateDescription(pay, inCurrency, outCurrency) {
  const inCurrencyRateInUsd = pay.exchangePrice * exchangerUtils.getRate(outCurrency, 'USD');
  const outCurrencyRateInUsd = exchangerUtils.getRate(inCurrency, 'USD') / pay.exchangePrice;

  let description =
    `_${pay.inAmountMessage}_ _${inCurrency}_ (got from the user) for **${pay.outAmount}** **${outCurrency}** ` +
    `(to be sent to the user) at _${pay.exchangePrice}_ _${outCurrency}_ / _${inCurrency}_`;

  description += ` (buying ${inCurrency} at ${inCurrencyRateInUsd.toFixed(inCurrencyRateInUsd < 0.02 ? 4 : 2)} USD`;

  if (outCurrency !== 'BTC') {
    const inCurrencyRateInBtc = pay.exchangePrice * exchangerUtils.getRate(outCurrency, 'BTC');

    description += `, ${inCurrencyRateInBtc.toFixed(8)} BTC`;
  }

  description += `, selling ${outCurrency} at ${outCurrencyRateInUsd.toFixed(outCurrencyRateInUsd < 0.02 ? 4 : 2)} USD`;

  if (inCurrency !== 'BTC') {
    const outCurrencyRateInBtc = exchangerUtils.getRate(inCurrency, 'BTC') / pay.exchangePrice;

    description += `, ${outCurrencyRateInBtc.toFixed(8)} BTC`;
  }

  return `${description})`;
}

/**
 * Runs the basic checks on an exchange request and records the resulting payment.
 *
 * This is the cheap, off-chain half of the validation: it decides whether the bot
 * can work with the coins, the amount and the limits at all. Whether the announced
 * transfer really happened is settled later, by `deepExchangeValidator`.
 *
 * @param {object} itx Stored incoming transaction
 * @param {object} tx ADAMANT transaction
 * @param {object} [payToUpdate] Payment that is awaiting clarification
 * @returns {Promise<void>}
 */
module.exports = (itx, tx, payToUpdate) =>
  withSenderLock(tx?.senderId ?? itx?.senderId, () => handleExchangeRequest(itx, tx, payToUpdate));

/**
 * Runs the basic checks for one exchange request; see the exported function.
 *
 * @param {object} itx Stored incoming transaction
 * @param {object} tx ADAMANT transaction
 * @param {object} [payToUpdate] Payment that is awaiting clarification
 * @returns {Promise<void>}
 */
async function handleExchangeRequest(itx, tx, payToUpdate) {
  const admTxDescription =
    `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${tx?.id} from ${tx?.senderId}` +
    `${payToUpdate ? ` as an update for Tx ${payToUpdate._id}` : ''}`;

  try {
    const { paymentsDb } = db;
    const { inAmountMessage, inCurrency, outCurrency, inTxid } = parseExchangeRequest(itx, tx, payToUpdate);

    let pay;
    let claimIsLate = false;

    if (payToUpdate) {
      const fresh = await paymentsDb.findOne({ _id: payToUpdate._id });

      if (fresh) {
        if (fresh.needToSendBack || fresh.isFinished || !utils.isAwaitingClarification(fresh)) {
          log.warn(
            `Skipping clarification update for payment ${payToUpdate._id}: it was concurrently cancelled or refunded. ${admTxDescription}.`,
          );
          await itx.update({ isProcessed: true }, true);

          return;
        }

        Object.assign(payToUpdate, fresh);
      } else if (payToUpdate.needToSendBack || payToUpdate.isFinished || !utils.isAwaitingClarification(payToUpdate)) {
        log.warn(
          `Skipping clarification update for payment ${payToUpdate._id}: it was concurrently cancelled or refunded. ${admTxDescription}.`,
        );
        await itx.update({ isProcessed: true }, true);

        return;
      }

      pay = payToUpdate;
      pay.outCurrency = outCurrency;

      const claim = await depositClaims.registerClaim({
        paymentId: pay._id,
        depositKey: pay.depositKey,
        senderId: pay.senderId,
        inCurrency: pay.inCurrency,
        inTxid: pay.inTxid,
        date: pay.date,
      });

      claimIsLate = claim.isLate;

      log.log(
        `Updating ${pay.inUpdateState} for an exchange of ${inAmountMessage} ${inCurrency}… ${admTxDescription}.`,
      );

      pay.inUpdateState = undefined;
    } else {
      // A payment is keyed by its ADAMANT transaction, and saving a fresh one over an
      // existing one would reset its progress and message the user again. Requests from
      // one user are serialized, so this check is exact within the process; the parser
      // already keeps one transaction from being handled twice at the same time.
      if (await paymentsDb.findOne({ _id: tx.id })) {
        log.warn(
          `The payment for the ADM Tx ${tx.id} already exists, so it is not created again. ${admTxDescription}.`,
        );

        return;
      }

      log.log(
        `Checking an exchange of ${inAmountMessage} ${inCurrency} for ${outCurrency || '{ not set yet }'}… ${admTxDescription}.`,
      );

      const depositKey = depositClaims.getDepositKey(inCurrency, inTxid);
      const claim = depositKey
        ? await depositClaims.registerClaim({
            paymentId: tx.id,
            depositKey,
            senderId: tx.senderId,
            inCurrency,
            inTxid,
          })
        : {};

      claimIsLate = claim.isLate;

      pay = new paymentsDb({
        _id: tx.id,
        date: utils.unix(),
        admTxId: tx.id,
        itxId: itx._id,
        senderId: tx.senderId,
        inCurrency,
        outCurrency,
        inTxid,
        depositKey,
        depositClaimVersion: 1,
        inAmountMessage: Number(inAmountMessage),
        isBasicChecksPassed: false,
        transactionIsValid: null,
        needHumanCheck: false,
        needToSendBack: false,
        transactionIsFailed: false,
        isFinished: false,
      });
    }

    let msgSendBack = false;
    let msgNotify = false;
    let notifyType = 'info';

    const minConfirmations = config[`min_confirmations_${inCurrency}`] ?? config.min_confirmations;
    const sendBackMessage =
      `I’ll send the transfer back to you once I validate it and it gets _${minConfirmations}_ block confirmations. ` +
      'That can take a while, so please be patient.';

    if (!inAmountMessage || !inCurrency || outCurrency === undefined || !inTxid) {
      pay.isFinished = true;
      pay.error = BASIC_CHECK_ERRORS.WRONG_REQUEST;
      notifyType = 'error';
      msgNotify = `${config.notifyName} considers the transaction of _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency || '{ not set yet }'}_ with Tx ID _${inTxid}_ to be malformed. ADM message: ${itx.decryptedMessage}. Ignoring this transaction. ${admTxDescription}.`;
      msgSendBack = `I consider the transaction of _${inAmountMessage}_ _${inCurrency}_ with Tx ID _${inTxid}_ to be malformed, so it will not be processed. If you think it’s a mistake, contact my master.`;
    } else if (!pay.depositKey && exchangerUtils.isKnown(inCurrency)) {
      pay.isFinished = true;
      pay.error = BASIC_CHECK_ERRORS.WRONG_REQUEST;
      notifyType = 'error';
      msgNotify = `${config.notifyName} considers the transaction id _${inTxid}_ for _${inCurrency}_ to be malformed. Ignoring this transaction. ${admTxDescription}.`;
      msgSendBack = `I consider the transaction id _${inTxid}_ for _${inCurrency}_ to be malformed, so it will not be processed. If you think it’s a mistake, contact my master.`;
    } else if (claimIsLate) {
      pay.isFinished = true;
      pay.error = BASIC_CHECK_ERRORS.DUPLICATE_TX;
      notifyType = 'error';
      msgNotify = `${config.notifyName} considers the transaction of _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency || '{ not set yet }'}_ to be a duplicate. Tx hash: _${inTxid}_. Ignoring this transaction. ${admTxDescription}.`;
      msgSendBack = `I consider the transaction of _${inAmountMessage}_ _${inCurrency}_ with Tx ID _${inTxid}_ to be a duplicate, so it will not be processed. If you think it’s a mistake, contact my master.`;
    } else if (!utils.isPositiveNumber(pay.inAmountMessage)) {
      pay.isFinished = true;
      pay.error = BASIC_CHECK_ERRORS.WRONG_AMOUNT;
      notifyType = 'error';
      msgNotify = `${config.notifyName} can’t understand the amount _${inAmountMessage}_ of _${inCurrency}_. Requested _${outCurrency || '{ not set yet }'}_. Tx hash: _${inTxid}_. Ignoring this transaction. ${admTxDescription}.`;
      msgSendBack = `I can’t understand the amount _${inAmountMessage}_ of _${inCurrency}_. If you think it’s a mistake, contact my master.`;
    } else if (!exchangerUtils.isKnown(inCurrency)) {
      pay.error = BASIC_CHECK_ERRORS.UNKNOWN_IN_CURRENCY;
      pay.needHumanCheck = true;
      pay.isFinished = true;
      notifyType = 'error';
      msgNotify = `${config.notifyName} reports an incoming transfer of an unknown coin: _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency || '{ not set yet }'}_. **Attention needed**. ${admTxDescription}.`;
      msgSendBack = `I don’t know the coin _${inCurrency}_. I accept ${utils.replaceLastOccurrence(exchangerUtils.acceptedCryptoList, ', ', ' and ')} for exchange. I’ve asked my master to send the payment back to you.`;
    } else if (!exchangerUtils.isAccepted(inCurrency)) {
      pay.error = BASIC_CHECK_ERRORS.UNACCEPTED_IN_CURRENCY;
      pay.needToSendBack = true;
      pay.isBasicChecksPassed = true;
      notifyType = 'warn';
      msgNotify = `${config.notifyName} reports an incoming transfer of a coin it does not accept: _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency || '{ not set yet }'}_. Will try to send the payment back. ${admTxDescription}.`;
      msgSendBack = `I don’t accept _${inCurrency}_. Send me ${utils.replaceLastOccurrence(exchangerUtils.acceptedCryptoList, ', ', ' or ')} for exchange. ${sendBackMessage}`;
    } else if (!exchangerUtils.hasTicker(inCurrency)) {
      pay.error = BASIC_CHECK_ERRORS.NO_RATES;

      if (exchangerUtils.isERC20(inCurrency)) {
        // Without a rate the bot cannot convert the ETH network fee into the token,
        // so it cannot work out what a refund would cost.
        pay.needHumanCheck = true;
        pay.isFinished = true;
        notifyType = 'error';
        msgNotify = `${config.notifyName} has no rates for the incoming coin _${inCurrency}_. Incoming transfer: _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency || '{ not set yet }'}_. **Attention needed**. ${admTxDescription}.`;
        msgSendBack = `I don’t have rates for the coin _${inCurrency}_ and can’t send the payment back on my own. I’ve asked my master to send it back to you.`;
      } else {
        pay.needToSendBack = true;
        pay.isBasicChecksPassed = true;
        notifyType = 'warn';
        msgNotify = `${config.notifyName} has no rates for the incoming coin _${inCurrency}_. Requested _${outCurrency || '{ not set yet }'}_. Will try to send the payment of _${inAmountMessage}_ _${inCurrency}_ back. ${admTxDescription}.`;
        msgSendBack = `I don’t have rates for the coin _${inCurrency}_. ${sendBackMessage}`;
      }
    } else {
      pay.inAmountMessageUsd = exchangerUtils.convertCryptos(inCurrency, 'USD', pay.inAmountMessage).outAmount;

      // Excludes this payment itself, which is already stored when a clarification is
      // being applied. Exact because requests from one user are serialized.
      const userDailyValue = await exchangerUtils.userDailyValue(tx.senderId, pay._id);
      // 0 means "no limit".
      const userDailyLimit = config[`daily_limit_usd_${outCurrency}`] || undefined;

      log.log(`The daily exchange volume of ${tx.senderId} is ${userDailyValue} USD.`);

      const inCurrencyPriceUsd = exchangerUtils.getRate(inCurrency, 'USD');
      const outCurrencyPriceUsd = exchangerUtils.getRate(outCurrency, 'USD');
      const maxInCurrencyBuyPriceUsd = config[`max_buy_price_usd_${inCurrency}`];
      const minOutCurrencySellPriceUsd = config[`min_sell_price_usd_${outCurrency}`];

      if (!utils.isPositiveOrZeroNumber(pay.inAmountMessageUsd) || pay.inAmountMessageUsd < config.min_value_usd) {
        pay.error = BASIC_CHECK_ERRORS.BELOW_MIN_VALUE;
        pay.needToSendBack = true;
        pay.isBasicChecksPassed = true;
        notifyType = 'warn';
        msgNotify = `${config.notifyName} reports an incoming transaction below the minimum value of _${config.min_value_usd}_ USD: _${inAmountMessage}_ _${inCurrency}_ ~ _${pay.inAmountMessageUsd}_ USD. Requested _${outCurrency || '{ not set yet }'}_. Will try to send the payment back. ${admTxDescription}.`;
        msgSendBack = `The exchange is worth _${pay.inAmountMessageUsd}_ USD, and I don’t accept exchanges below _${config.min_value_usd}_ USD. ${sendBackMessage}`;
      } else if (maxInCurrencyBuyPriceUsd && inCurrencyPriceUsd > maxInCurrencyBuyPriceUsd) {
        pay.error = BASIC_CHECK_ERRORS.BUY_PRICE_TOO_HIGH;
        pay.needToSendBack = true;
        pay.isBasicChecksPassed = true;
        notifyType = 'warn';
        msgNotify = `${config.notifyName} reports an incoming transaction to buy ${inCurrency} at ${inCurrencyPriceUsd} USD, which is above the ${maxInCurrencyBuyPriceUsd} USD set in the config. Requested _${outCurrency || '{ not set yet }'}_. Will try to send the payment back. ${admTxDescription}.`;
        msgSendBack = `${inCurrency} currently trades at ${inCurrencyPriceUsd} USD, which is too high. I’ll hold off buying it because the rate may swing. Try again later. ${sendBackMessage}`;
      } else if (!exchangerUtils.isKnown(outCurrency)) {
        pay.inUpdateState = 'outCurrency';
        msgSendBack = outCurrency
          ? `I don’t work with the coin _${outCurrency}_. You can choose between ${await exchangerUtils.getExchangedCryptoList(inCurrency)}.`
          : `I’ve got _${inAmountMessage}_ _${inCurrency}_ from you. Tell me which coin you want in exchange: ${await exchangerUtils.getExchangedCryptoList(inCurrency)}.`;
      } else if (userDailyLimit && userDailyValue + pay.inAmountMessageUsd >= userDailyLimit) {
        pay.error = BASIC_CHECK_ERRORS.DAILY_LIMIT_EXCEEDED;
        pay.needToSendBack = true;
        pay.isBasicChecksPassed = true;
        notifyType = 'warn';
        msgNotify = `${config.notifyName} reports that the user _${tx.senderId}_ exceeds the daily limit of _${userDailyLimit}_ USD with a transfer of _${inAmountMessage} ${inCurrency}_ to _${outCurrency || '{ not set yet }'}_. Will try to send the payment back. ${admTxDescription}.`;
        msgSendBack = `You have exceeded the maximum daily volume of _${userDailyLimit}_ USD. ${sendBackMessage}`;
      } else if (inCurrency === outCurrency) {
        pay.inUpdateState = 'outCurrency';
        msgSendBack = `Exchanging _${inCurrency}_ for _${outCurrency}_ is no trouble, but I think you made the request by mistake. Tell me which coin you want in exchange: ${await exchangerUtils.getExchangedCryptoList(inCurrency)}.`;
      } else if (!exchangerUtils.isExchanged(outCurrency)) {
        pay.inUpdateState = 'outCurrency';
        msgSendBack = `I don’t exchange to _${outCurrency}_. You can choose between ${await exchangerUtils.getExchangedCryptoList(inCurrency)}.`;
      } else if (!exchangerUtils.hasTicker(outCurrency)) {
        pay.inUpdateState = 'outCurrency';
        msgSendBack = `I don’t have rates for the coin _${outCurrency}_. You can choose between ${await exchangerUtils.getExchangedCryptoList(inCurrency)}.`;
      } else if (minOutCurrencySellPriceUsd && outCurrencyPriceUsd < minOutCurrencySellPriceUsd) {
        pay.error = BASIC_CHECK_ERRORS.SELL_PRICE_TOO_LOW;
        pay.needToSendBack = true;
        pay.isBasicChecksPassed = true;
        notifyType = 'warn';
        msgNotify = `${config.notifyName} reports an incoming transaction to sell ${outCurrency} at ${outCurrencyPriceUsd} USD, which is below the ${minOutCurrencySellPriceUsd} USD set in the config. Got _${inAmountMessage} ${inCurrency}_. Will try to send the payment back. ${admTxDescription}.`;
        msgSendBack = `${outCurrency} currently trades at ${outCurrencyPriceUsd} USD, which is too low. I’ll hold off selling it because the rate may swing. Try again later. ${sendBackMessage}`;
      }

      if (!pay.isFinished && !pay.needToSendBack && !pay.inUpdateState) {
        await pay.update(exchangerUtils.convertCryptos(inCurrency, outCurrency, pay.inAmountMessage, true));

        const feeCurrency = exchangerUtils.isERC20(outCurrency) ? 'ETH' : outCurrency;
        const networkFee = exchangerUtils[outCurrency].FEE;

        if (!pay.outAmount || Number.isNaN(pay.outAmount)) {
          pay.error = BASIC_CHECK_ERRORS.WRONG_AMOUNT;
          pay.needToSendBack = true;
          pay.isBasicChecksPassed = true;
          notifyType = 'warn';
          msgNotify = `${config.notifyName} is unable to calculate the _${outCurrency}_ value of _${pay.inAmountMessage}_ _${inCurrency}_. Will try to send the payment back. ${admTxDescription}.`;
          msgSendBack = `I can’t calculate how much _${outCurrency}_ _${inAmountMessage}_ _${inCurrency}_ is worth. ${sendBackMessage}`;
        } else if (!utils.isPositiveNumber(pay.outAmount)) {
          pay.error = BASIC_CHECK_ERRORS.WRONG_REQUEST;
          pay.needToSendBack = true;
          pay.isBasicChecksPassed = true;
          notifyType = 'warn';
          msgNotify = `${config.notifyName} reports an incoming transaction that doesn’t cover the network Tx fee of ${networkFee} ${feeCurrency}: _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency}_. Will try to send the payment back. ${admTxDescription}.`;
          msgSendBack = `_${inAmountMessage}_ _${inCurrency}_ doesn’t cover the network Tx fee of ${networkFee} ${feeCurrency}. ${sendBackMessage}`;
        } else if (exchangerUtils.isLowerThanMinBalance(pay.outAmount, outCurrency)) {
          pay.error = BASIC_CHECK_ERRORS.BELOW_MIN_TRANSFER;
          pay.needToSendBack = true;
          pay.isBasicChecksPassed = true;
          notifyType = 'warn';
          msgNotify = `${config.notifyName} is unable to exchange _${inAmountMessage}_ _${inCurrency}_ for _${pay.outAmount}_ _${outCurrency}_, because that is less than the minimum of _${constants.minBalances[outCurrency]}_ _${outCurrency}_. Will try to send the payment back. ${admTxDescription}.`;
          msgSendBack = `I can’t send you _${pay.outAmount}_ _${outCurrency}_, because that is less than the minimum of _${constants.minBalances[outCurrency]}_ _${outCurrency}_. ${sendBackMessage}`;
        } else {
          pay.isBasicChecksPassed = true;
          notifyType = 'log';

          const conversionStringSendBack = `_${inAmountMessage}_ _${inCurrency}_ for **${pay.outAmount}** **${outCurrency}** at _${pay.exchangePrice}_ _${outCurrency}_ / _${inCurrency}_`;

          msgNotify = `${config.notifyName} reports an incoming transaction to exchange ${formRateDescription(pay, inCurrency, outCurrency)}. Tx hash: _${inTxid}_. ${admTxDescription}.`;
          msgSendBack =
            `I’ve got your request to exchange ${conversionStringSendBack}. Now I’ll validate the transaction` +
            `${exchangerUtils.isFastPayments(inCurrency) ? ' and' : ` and wait for _${minConfirmations}_ block confirmations, then`} make the exchange. ` +
            'That can take a while, so please be patient.';
        }
      }
    }

    await pay.save();

    if (pay.depositKey && pay.isFinished) {
      await depositClaims.setClaimStatus(pay._id, depositClaims.CLAIM_STATUS.INELIGIBLE, {
        reason: `basic-check-error-${pay.error}`,
      });
    } else if (pay.depositKey && pay.inUpdateState) {
      await depositClaims.setClaimStatus(pay._id, depositClaims.CLAIM_STATUS.AWAITING_CLARIFICATION);
    } else if (pay.depositKey && pay.isBasicChecksPassed) {
      await depositClaims.setClaimStatus(pay._id, depositClaims.CLAIM_STATUS.PENDING);
    }
    await itx.update({ isProcessed: true }, true);

    if (msgNotify) {
      notify(msgNotify, notifyType);
    }

    await messenger.sendMessage(tx.senderId, msgSendBack);
  } catch (error) {
    notify(
      `Error while processing the exchange Tx ${tx?.id} from ${tx?.senderId} in ${utils.getModuleName(module.id)} module. You may need to process it manually — see the logs. Error: ${error}`,
      'error',
    );
  }
}
