const config = require('./configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const db = require('./DB');
const api = require('./api');

module.exports = async (pay) => {

  const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay ? pay.admTxId : 'undefined'} from ${pay ? pay.senderId : 'undefined'}`;
  try {

    log.log(`Updating incoming Tx ${pay.inTxid} confirmations… ${admTxDescription}.`);

    const tx = await exchangerUtils[pay.inCurrency].getTransaction(pay.inTxid);
    if (!tx) {
      log.warn(`Unable to fetch validated Tx ${pay.inTxid} info. Will try again next time. ${admTxDescription}.`);
      return;
    }

    pay.inTxStatus = tx.status;
    if (pay.inTxStatus === false) {
      pay.update({
        error: constants.ERRORS.TX_FAILED,
        transactionIsFailed: true,
        isFinished: true,
        inTxConfirmed: false,
      }, true);
      const msgNotify = `${config.notifyName} notifies transaction _${pay.inTxid}_ of _${pay.inAmountMessage}_ _${pay.inCurrency}_ is Failed. ${admTxDescription}.`;
      const msgSendBack = `Transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_ is Failed and will not be processed. Check _${pay.inCurrency}_ blockchain explorer and try again. If you think it’s a mistake, contact my master.`;
      notify(msgNotify, 'error');
      api.sendMessage(config.passPhrase, pay.senderId, msgSendBack).then((response) => {
        if (!response.success) {
          log.warn(`Failed to send ADM message '${msgSendBack}' to ${pay.senderId}. ${response.errorMessage}.`);
        }
      });
      return;
    }

    if (!tx.height && !tx.confirmations && !pay.inTxIsInstant) {
      log.warn(`Unable to get Tx ${pay.inTxid} height or confirmations. Will try again next time. ${admTxDescription}.`);
      return;
    }

    let confirmations = tx.confirmations;
    if (!tx.confirmations && tx.height) {
      const lastBlockHeight = await exchangerUtils[pay.inCurrency].getLastBlockHeight();
      if (!lastBlockHeight) {
        log.warn(`Unable to get last block height for ${pay.inCurrency} to count Tx ${pay.inTxid} confirmations in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
        return;
      }
      confirmations = lastBlockHeight - tx.height + 1;
    }

    pay.update({
      inTxStatus: tx.status,
      inConfirmations: confirmations,
    });

    if (pay.inTxStatus && pay.inConfirmations >= config['min_confirmations_' + pay.inCurrency]) {
      pay.inTxConfirmed = true;
      log.log(`Tx ${pay.inTxid} is confirmed, it reached minimum of ${config['min_confirmations_' + pay.inCurrency]} network confirmations. ${admTxDescription}.`);
    } else if (pay.inTxIsInstant) {
      pay.inTxConfirmed = true;
      log.log(`Tx ${pay.inTxid} is confirmed as InstantSend verified. Currently it has ${pay.inConfirmations ? pay.inConfirmations : 0} network confirmations. ${admTxDescription}.`);
    } else {
      log.log(`Updated Tx ${pay.inTxid} confirmations: ${pay.inConfirmations && pay.inConfirmations >= 0 ? pay.inConfirmations : 0}. ${admTxDescription}.`);
    }

    await pay.save();

  } catch (e) {
    log.error(`Failed to get Tx ${pay ? pay.inTxid : 'undefined'} confirmations: ${e.toString()}. Will try again next time. ${admTxDescription}.`);
  }

};

setInterval(async () => {
  const { paymentsDb } = db;
  (await paymentsDb.find({
    isBasicChecksPassed: true,
    transactionIsValid: true,
    isFinished: false,
    transactionIsFailed: false,
    inTxConfirmed: { $ne: true },
  })).forEach(async (pay) => {
    module.exports(pay);
  });
}, constants.CONFIRMATIONS_INTERVAL);
