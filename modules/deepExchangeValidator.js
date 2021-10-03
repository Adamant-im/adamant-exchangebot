const log = require('../helpers/log');
const notify = require('../helpers/notify');
const config = require('./configReader');
const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const db = require('./DB');
const api = require('./api');

module.exports = async (pay, tx) => {

  const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${tx ? tx.id : 'undefined'} from ${tx ? tx.senderId : 'undefined'}`;
  try {

    log.log(`Validating Tx ${pay.inTxid}… ${admTxDescription}.`);

    pay.counterTxDeepValidator = ++pay.counterTxDeepValidator || 0;
    let msgSendBack = false;
    let msgNotify = false;

    // Fetching addresses from ADAMANT KVS
    const senderKvsInAddress = pay.senderKvsInAddress || pay.inCurrency === 'ADM' && tx.senderId ||
      await exchangerUtils.getKvsCryptoAddress(pay.inCurrency, tx.senderId);
    const senderKvsOutAddress = pay.senderKvsOutAddress || pay.outCurrency === 'ADM' && tx.senderId ||
      await exchangerUtils.getKvsCryptoAddress(pay.outCurrency, tx.senderId);

    pay.update({
      senderKvsInAddress,
      senderKvsOutAddress,
    });

    if (!senderKvsInAddress) {
      log.warn(`Unable to fetch ${pay.inCurrency} inCurrency address for ${tx.senderId} from KVS. Will try next time. ${admTxDescription}.`);
      pay.save();
      return;
    }

    if (!senderKvsOutAddress && !pay.needToSendBack) {
      log.warn(`Unable to fetch ${pay.outCurrency} outCurrency address for ${tx.senderId} from KVS. Will try next time. ${admTxDescription}.`);
      pay.save();
      return;
    }

    let notifyType = 'log';
    if (senderKvsInAddress === 'none') {
      pay.update({
        error: constants.ERRORS.NO_IN_KVS_ADDRESS,
        isFinished: true,
        needHumanCheck: true,
      }, true);
      notifyType = 'error';
      msgNotify = `${config.notifyName} cannot fetch inCurrency address from KVS for crypto: _${pay.inCurrency}_. Attention needed. ${admTxDescription}.`;
      msgSendBack = `I can’t get your _${pay.inCurrency}_ address from ADAMANT KVS. If you think it’s a mistake, contact my master.`;
      notify(msgNotify, notifyType);
      api.sendMessage(config.passPhrase, tx.senderId, msgSendBack).then((response) => {
        if (!response.success) {
          log.warn(`Failed to send ADM message '${msgSendBack}' to ${tx.senderId}. ${response.errorMessage}.`);
        }
      });
      return;
    };

    if (senderKvsOutAddress === 'none' && !pay.needToSendBack) {
      pay.update({
        needToSendBack: true,
        error: constants.ERRORS.NO_OUT_KVS_ADDRESS,
      });
      notifyType = 'warn';
      msgNotify = `${config.notifyName} cannot fetch outCurrency address from KVS for crypto: _${pay.outCurrency}_. Will try to send payment back.`;
      msgSendBack = `I can’t get your _${pay.outCurrency}_ address from ADAMANT KVS. Make sure you use ADAMANT wallet with _${pay.outCurrency}_ enabled. I’ll validate the transfer and send it back to you. It can take a time, please be patient.`;
    }

    // Validating incoming TX in blockchain of inCurrency

    const incomeTx = await exchangerUtils[pay.inCurrency].getTransaction(pay.inTxid);
    if (!incomeTx) {
      if (pay.counterTxDeepValidator < constants.VALIDATOR_GET_TX_RETRIES) {
        pay.save();
        log.warn(`Unable to get Tx ${pay.inTxid} (${pay.counterTxDeepValidator}/${constants.VALIDATOR_GET_TX_RETRIES}). It's expected, if the Tx is new. Will try again next time. ${admTxDescription}.`);
        return;
      }
      pay.update({
        transactionIsValid: false,
        isFinished: true,
        error: constants.ERRORS.UNABLE_TO_FETCH_TX,
      });
      notifyType = 'warn';
      msgNotify = `${config.notifyName} can’t fetch transaction of _${pay.inAmountMessage} ${pay.inCurrency}_. It might be failed or cancelled.`;
      msgSendBack = `I can’t fetch transaction of _${pay.inAmountMessage} ${pay.inCurrency}_ with Tx ID _${pay.inTxid}_ from _${pay.inCurrency}_ blockchain. It might be failed or cancelled. If you think it’s a mistake, contact my master.`;
    } else { // We got incomeTx details

      pay.update({
        inTxSenderId: incomeTx.senderId,
        inTxRecipientId: incomeTx.recipientId,
        inAmountReal: incomeTx.amount,
        inTxFee: incomeTx.fee,
        inTxStatus: incomeTx.status,
        inTxHeight: incomeTx.height,
        inTxTimestamp: incomeTx.timestamp,
        inTxIsInstant: incomeTx.instantlock && incomeTx.instantlock_internal,
        inTxInstantChainlock: incomeTx.chainlock,
        inConfirmations: incomeTx.confirmations,
      });

      if (!pay.inTxSenderId || !pay.inTxRecipientId || !pay.inAmountReal || (!pay.inTxTimestamp && !pay.inTxIsInstant)) {
        pay.save();
        log.warn(`Unable to get full details of transaction. inTxSenderId: ${pay.inTxSenderId}, inTxRecipientId: ${pay.inTxRecipientId}, inAmountReal: ${pay.inAmountReal}, inTxTimestamp: ${pay.inTxTimestamp}. Will try again next time. Tx hash: ${pay.inTxid}. ${admTxDescription}.`);
        return;
      }

      const deltaAmount = Math.abs(pay.inAmountReal - pay.inAmountMessage);
      const deltaTimestamp = Math.abs(utils.toTimestamp(tx.timestamp) - pay.inAmountMessage);
      if (!utils.isStringEqualCI(pay.inTxSenderId, pay.senderKvsInAddress)) {
        pay.update({
          transactionIsValid: false,
          isFinished: true,
          error: constants.ERRORS.WRONG_SENDER,
        });
        notifyType = 'error';
        msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Sender expected: _${senderKvsInAddress}_, but real sender is _${pay.inTxSenderId}_.`;
        msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
      } else if (!utils.isStringEqualCI(pay.inTxRecipientId, exchangerUtils[pay.inCurrency].account.address)) {
        pay.update({
          transactionIsValid: false,
          isFinished: true,
          error: constants.ERRORS.WRONG_RECIPIENT,
        });
        notifyType = 'error';
        msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Recipient expected: _${exchangerUtils[pay.inCurrency].account.address}_, but real recipient is _${pay.inTxRecipientId}_.`;
        msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
      } else if (deltaAmount > pay.inAmountReal * constants.VALIDATOR_AMOUNT_DEVIATION) {
        pay.update({
          transactionIsValid: false,
          isFinished: true,
          error: constants.ERRORS.WRONG_AMOUNT,
        });
        notifyType = 'error';
        msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Amount expected: _${pay.inAmountMessage}_, but real amount is _${pay.inAmountReal}_.`;
        msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
      } else if ((!pay.inTxTimestamp && !pay.inTxIsInstant) && (deltaTimestamp > constants.VALIDATOR_TIMESTAMP_DEVIATION)) {
        pay.update({
          transactionIsValid: false,
          isFinished: true,
          error: constants.ERRORS.WRONG_TIMESTAMP,
        });
        notifyType = 'error';
        msgNotify = `${config.notifyName} thinks transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is wrong. Tx's timestamp is _${(Math.abs(utils.toTimestamp(tx.timestamp) - pay.inAmountMessage) / constants.HOUR).toFixed(0)}_ hours late.`;
        msgSendBack = `I can’t validate transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
      } else { // Transaction is valid
        pay.update({
          transactionIsValid: true,
        });
      }
    } // We got incomeTx details

    await pay.save();

    if (msgSendBack) {
      notify(msgNotify + ` Tx hash: _${pay.inTxid}_. ${admTxDescription}.`, notifyType);
      api.sendMessage(config.passPhrase, tx.senderId, msgSendBack).then((response) => {
        if (!response.success) {
          log.warn(`Failed to send ADM message '${msgSendBack}' to ${tx.senderId}. ${response.errorMessage}.`);
        }
      });
    }

  } catch (e) {
    log.error(`Failed to validate Tx ${pay ? pay.inTxid : 'undefined'}: ${e.toString()}. Will try again next time. ${admTxDescription}.`);
  }
};

setInterval(async () => {
  const { paymentsDb } = db;
  (await paymentsDb.find({
    transactionIsValid: null,
    isBasicChecksPassed: true,
    isFinished: false,
  })).forEach(async (pay) => {
    const tx = await api.get('transactions/get', { id: pay.admTxId });
    if (tx.success) {
      module.exports(pay, tx.data.transaction);
    } else {
      log.warn(`Unable to fetch Tx ${pay.admTxId} in setInterval() of ${utils.getModuleName(module.id)} module. ${tx.errorMessage}.`);
    }
  });
}, constants.VALIDATOR_TX_INTERVAL);
