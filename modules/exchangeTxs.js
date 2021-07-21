
const db = require('./DB');
const { SAT } = require('../helpers/const');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const utils = require('../helpers/utils');
const notify = require('../helpers/notify');
const log = require('../helpers/log');
const config = require('./configReader');
const constants = require('../helpers/const');
const api = require('./api');

module.exports = async (itx, tx, payToUpdate) => {

  const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${tx ? tx.id : 'undefined'} from ${tx ? tx.senderId : 'undefined'}${payToUpdate ? ' as an update for Tx ' + payToUpdate._id : ''}`;
  try {

    const { paymentsDb } = db;
    const msg = itx.decryptedMessage;
    let inCurrency,
      outCurrency,
      inTxid,
      inAmountMessage;

    if (payToUpdate && payToUpdate.inUpdateState === 'outCurrency') { // update of outCurrency for previous Tx
      inAmountMessage = payToUpdate.inAmountMessage;
      inCurrency = payToUpdate.inCurrency;
      outCurrency = msg;
      inTxid = payToUpdate._id;
    } else if (tx.amount > 0) { // ADM income payment
      inAmountMessage = tx.amount / SAT;
      inCurrency = 'ADM';
      outCurrency = msg;
      inTxid = tx.id;
    } else if (msg.includes('_transaction')) { // not ADM income payment
      inCurrency = msg.match(/"type":"(.*)_transaction/)[1];
      const inTxDetails = utils.tryParseJSON(msg);
      if (inTxDetails) {
        inAmountMessage = inTxDetails.amount; // expected string type
        inTxid = inTxDetails.hash;
        outCurrency = inTxDetails.comments;
      }
    }

    inCurrency = String(inCurrency).toUpperCase().trim();
    outCurrency = utils.trimAny(outCurrency, ` '",.<>()$!*-=+{}[]?/\\`).toUpperCase();

    let pay;
    let inTxidDublicate = false;

    if (payToUpdate) {
      pay = payToUpdate;
      pay.outCurrency = outCurrency;
      log.log(`Updating ${pay.inUpdateState} for an exchange of ${inAmountMessage} ${inCurrency}… ${admTxDescription}.`);
      pay.inUpdateState = undefined;
    } else {
      log.log(`Checking an exchange of ${inAmountMessage} ${inCurrency} for ${outCurrency ? outCurrency : 'NOT_SET'}… ${admTxDescription}.`);
      inTxidDublicate = await paymentsDb.findOne({ inTxid });
      pay = new paymentsDb({
        _id: tx.id,
        date: utils.unix(),
        admTxId: tx.id,
        itxId: itx._id,
        senderId: tx.senderId,
        inCurrency,
        outCurrency,
        inTxid,
        inAmountMessage: +inAmountMessage,
        isBasicChecksPassed: false,
        transactionIsValid: null,
        needHumanCheck: false,
        needToSendBack: false,
        transactionIsFailed: false,
        isFinished: false
      });
    }

    // Validate
    let msgSendBack = false;
    let msgNotify = false;
    let notifyType = 'info';
    const min_confirmations = config['min_confirmations_' + inCurrency];
    const sendBackMessage = `I’ll send transfer back to you after I validate it and have _${min_confirmations}_ block confirmations. It can take a time, please be patient.`;

    // Checkers
    if (!inAmountMessage || !inCurrency || outCurrency === undefined || !inTxid) {
      pay.isFinished = true;
      pay.error = 8;
      notifyType = 'error';
      msgNotify = `${config.notifyName} thinks transaction of _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency}_ with Tx ID _${inTxid}_ is wrong. ADM message: ${msg}. Will ignore this transaction. ${admTxDescription}.`;
      msgSendBack = `I think transaction of _${inAmountMessage}_ _${inCurrency}_ with Tx ID _${inTxid}_ is wrong, it will not be processed. If you think it’s a mistake, contact my master.`;
    } else if (inTxidDublicate) {
      pay.isFinished = true;
      pay.error = 1;
      notifyType = 'error';
      msgNotify = `${config.notifyName} thinks transaction of _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency}_ is duplicated. Tx hash: _${inTxid}_. Will ignore this transaction. ${admTxDescription}.`;
      msgSendBack = `I think transaction of _${inAmountMessage}_ _${inCurrency}_ with Tx ID _${inTxid}_ is duplicated, it will not be processed. If you think it’s a mistake, contact my master.`;
    } else if (!utils.isPositiveNumber(pay.inAmountMessage)) {
      pay.isFinished = true;
      pay.error = 7;
      notifyType = 'error';
      msgNotify = `${config.notifyName} can't understand _${inAmountMessage}_ amount for _${inCurrency}_. Requested _${outCurrency}_. Tx hash: _${inTxid}_. Will ignore this transaction. ${admTxDescription}.`;
      msgSendBack = `I can't understand _${inAmountMessage}_ amount for _${inCurrency}_. If you think it’s a mistake, contact my master.`;
    } else if (!exchangerUtils.isKnown(inCurrency)) {
      pay.error = 2;
      pay.needHumanCheck = true;
      pay.isFinished = true;
      notifyType = 'error';
      msgNotify = `${config.notifyName} notifies about incoming transfer of unknown crypto: _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency}_. **Attention needed**. ${admTxDescription}.`;
      msgSendBack = `I don’t know crypto _${inCurrency}_. I accept ${utils.replaceLastOccurrence(exchangerUtils.acceptedCryptoList, ', ', ' and ')} for exchange. I’ve notified my master to send the payment back to you.`;
    } else if (!exchangerUtils.isAccepted(inCurrency)) {
      pay.error = 5;
      pay.needToSendBack = true;
      pay.isBasicChecksPassed = true;
      notifyType = 'warn';
      msgNotify = `${config.notifyName} notifies about incoming transfer of unaccepted crypto: _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency}_. Will try to send payment back. ${admTxDescription}.`;
      msgSendBack = `I don’t accept _${inCurrency}_. Send me ${utils.replaceLastOccurrence(exchangerUtils.acceptedCryptoList, ', ', ' or ')} for exchange. ${sendBackMessage}`;
    } else if (!exchangerUtils.hasTicker(inCurrency)) {
      if (exchangerUtils.isERC20(inCurrency)) { // Unable to send back, as we can't calc fee in ETH
        pay.error = 32;
        pay.needHumanCheck = true;
        pay.isFinished = true;
        notifyType = 'error';
        msgNotify = `${config.notifyName} notifies about unknown rates of incoming crypto _${inCurrency}_. Incoming transfer: _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency}_. **Attention needed**. ${admTxDescription}.`;
        msgSendBack = `I don’t have rates of crypto _${inCurrency}_ and unable to send payment back. I’ve notified my master to send the payment back to you.`;
      } else { // We can send payment back
        pay.error = 32;
        pay.needToSendBack = true;
        pay.isBasicChecksPassed = true;
        notifyType = 'warn';
        msgNotify = `${config.notifyName} notifies about unknown rates of incoming crypto _${inCurrency}_. Requested _${outCurrency}_. Will try to send payment of _${inAmountMessage}_ _${inCurrency}_ back. ${admTxDescription}.`;
        msgSendBack = `I don’t have rates of crypto _${inCurrency}_. ${sendBackMessage}`;
      }
    } else {
      // Calculating exchange amount in USD and comparing it to user's daily limit
      pay.inAmountMessageUsd = exchangerUtils.convertCryptos(inCurrency, 'USD', pay.inAmountMessage).outAmount;
      const userDailyValue = await exchangerUtils.userDailyValue(tx.senderId);
      log.log(`User's ${tx.senderId} daily volume is ${userDailyValue} USD.`);
      if (userDailyValue + pay.inAmountMessageUsd >= config.daily_limit_usd) {
        pay.error = 23;
        pay.needToSendBack = true;
        pay.isBasicChecksPassed = true;
        notifyType = 'warn';
        msgNotify = `${config.notifyName} notifies that user _${tx.senderId}_ exceeds daily limit of _${config.daily_limit_usd}_ USD with transfer of _${inAmountMessage} ${inCurrency}_ to _${outCurrency}_. Will try to send payment back. ${admTxDescription}.`;
        msgSendBack = `You have exceeded maximum daily volume of _${config.daily_limit_usd}_ USD. ${sendBackMessage}`;
      } else if (!utils.isPositiveOrZeroNumber(pay.inAmountMessageUsd) || pay.inAmountMessageUsd < config.min_value_usd) {
        pay.error = 20;
        pay.needToSendBack = true;
        pay.isBasicChecksPassed = true;
        notifyType = 'warn';
        msgNotify = `${config.notifyName} notifies about incoming transaction below minimum value of _${config.min_value_usd}_ USD: _${inAmountMessage}_ _${inCurrency}_ ~ _${pay.inAmountMessageUsd}_ USD. Requested _${outCurrency}_. Will try to send payment back. ${admTxDescription}.`;
        msgSendBack = `Exchange value equals _${pay.inAmountMessageUsd}_ USD. I don’t accept exchange crypto below minimum value of _${config.min_value_usd}_ USD. ${sendBackMessage}`;
      } else if (!exchangerUtils.isKnown(outCurrency)) { // Finally, check outCurrency
        pay.inUpdateState = 'outCurrency';
        if (outCurrency) {
          msgSendBack = `I don’t work with crypto _${outCurrency}_. You can choose between ${await exchangerUtils.getExchangedCryptoList(inCurrency)}.`;
        } else {
          msgSendBack = `I've got _${inAmountMessage}_ _${inCurrency}_ from you. Tell me what crypto you want to receive for exchange: ${await exchangerUtils.getExchangedCryptoList(inCurrency)}.`;
        }
      } else if (inCurrency === outCurrency) {
        pay.inUpdateState = 'outCurrency';
        msgSendBack = `Not a big deal to exchange _${inCurrency}_ for _${outCurrency}_, but I think you’ve made a request by mistake. Tell me what crypto you want to receive for exchange: ${await exchangerUtils.getExchangedCryptoList(inCurrency)}`;
      } else if (!exchangerUtils.isExchanged(outCurrency)) {
        pay.inUpdateState = 'outCurrency';
        msgSendBack = `I don’t accept exchange to _${outCurrency}_. You can choose between ${await exchangerUtils.getExchangedCryptoList(inCurrency)}.`;
      } else if (!exchangerUtils.hasTicker(outCurrency)) {
        pay.inUpdateState = 'outCurrency';
        msgSendBack = `I don’t have rates of crypto _${outCurrency}_. You can choose between ${await exchangerUtils.getExchangedCryptoList(inCurrency)}.`;
      }
    }

    // We've passed all of basic checks
    if (!pay.isFinished && !pay.needToSendBack && !pay.inUpdateState) {
      pay.update(exchangerUtils.convertCryptos(inCurrency, outCurrency, pay.inAmountMessage, true));
      if (!pay.outAmount) { // Error while calculating outAmount
        pay.error = 7;
        pay.needToSendBack = true;
        pay.isBasicChecksPassed = true;
        notifyType = 'warn';
        msgNotify = `${config.notifyName} unable to calculate _${outCurrency}_ value to exchange from _${pay.inAmountMessage}_ _${inCurrency}_. Will try to send payment back. ${admTxDescription}.`;
        msgSendBack = `I can't calculate _${outCurrency}_ amount to exchange from _${inAmountMessage}_ _${inCurrency}_. ${sendBackMessage}`;
      } else if (!utils.isPositiveNumber(pay.outAmount)) { // Doesn't cover network Tx fee
        pay.error = 8;
        pay.needToSendBack = true;
        pay.isBasicChecksPassed = true;
        notifyType = 'warn';
        let feeCurrency = exchangerUtils.isERC20(outCurrency) ? 'ETH' : outCurrency;
        msgNotify = `${config.notifyName} notifies about incoming transaction, that doesn't cover network Tx fee of ${exchangerUtils[outCurrency].FEE} ${feeCurrency}: _${inAmountMessage}_ _${inCurrency}_ to _${outCurrency}_. Will try to send payment back. ${admTxDescription}.`;
        msgSendBack = `_${inAmountMessage}_ _${inCurrency}_ doesn't cover network Tx fee of ${exchangerUtils[outCurrency].FEE} ${feeCurrency}. ${sendBackMessage}`;
      } else { // Transaction is fine
        pay.isBasicChecksPassed = true;
        notifyType = 'log';
        msgNotify = `${config.notifyName} notifies about incoming transaction to exchange _${inAmountMessage}_ _${inCurrency}_ for *${pay.outAmount}* *${outCurrency}* at _${pay.exchangePrice}_ _${outCurrency}_ / _${inCurrency}_. Tx hash: _${inTxid}_. ${admTxDescription}.`;
        msgSendBack = `I’ve got a request to exchange _${inAmountMessage}_ _${inCurrency}_ for **${pay.outAmount}** **${outCurrency}** at _${pay.exchangePrice}_ _${outCurrency}_ / _${inCurrency}_. Now I’ll validate your transfer${exchangerUtils.isFastPayments(inCurrency) ? ' and' : ' and wait for _' + min_confirmations + '_ block confirmations, then'} make an exchange. It can take a time, please be patient.`;
      }
    }

    await pay.save();
    await itx.update({ isProcessed: true }, true);

    if (msgNotify) {
      notify(msgNotify, notifyType);
    }
    api.sendMessage(config.passPhrase, tx.senderId, msgSendBack).then(response => {
      if (!response.success)
        log.warn(`Failed to send ADM message '${msgSendBack}' to ${tx.senderId}. ${response.errorMessage}.`);
    });

  } catch (e) {
    notify(`Error while processing exchange Tx ${tx ? tx.id : 'undefined'} from ${tx ? tx.senderId : 'undefined'} in ${utils.getModuleName(module.id)} module. You may need to process it manually, see logs. Error: ` + e, 'error');
  }

};
