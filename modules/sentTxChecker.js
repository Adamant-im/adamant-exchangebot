const db = require('./DB');
const config = require('./configReader');
const constants = require('../helpers/const');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const api = require('./api');
const utils = require('../helpers/utils');

module.exports = async () => {

  const { paymentsDb } = db;
  (await paymentsDb.find({
    $and: [
      { isFinished: false },
      {
        $or: [
          { outTxid: { $ne: null } },
          { sentBackTx: { $ne: null } },
        ],
      },
    ],
  })).forEach(async (pay) => {

    pay.tryCounterCheckOutTX = ++pay.tryCounterCheckOutTX || 0;

    let direction;
    let sendCurrency;
    let sendTxId;
    let sendAmount;
    let etherString;
    let notifyType;

    if (pay.outTxid) {
      direction = 'exchange';
      sendCurrency = pay.outCurrency;
      sendTxId = pay.outTxid;
      sendAmount = pay.outAmount;
    } else {
      direction = 'back';
      sendCurrency = pay.inCurrency;
      sendTxId = pay.sentBackTx;
      sendAmount = pay.sentBackAmount;
    }

    const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay.admTxId} from ${pay.senderId}`;

    try {

      log.log(`Updating sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} status and confirmations… ${admTxDescription}.`);

      let msgNotify = null;
      let msgSendBack = null;

      if (exchangerUtils.isERC20(sendCurrency)) {
        etherString = `Ether balance: ${exchangerUtils['ETH'].balance}. `;
      }

      const tx = await exchangerUtils[sendCurrency].getTransaction(sendTxId);
      if (!tx) {
        log.warn(`Unable to fetch sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} (${pay.tryCounterCheckOutTX}/${constants.SENDER_GET_TX_RETRIES}). It's expected, if the Tx is new. Will try again next time. ${admTxDescription}.`);
        if (pay.tryCounterCheckOutTX > constants.SENDER_GET_TX_RETRIES) {
          pay.update({
            errorCheckOuterTX: constants.ERRORS.UNABLE_TO_FETCH_SENT_TX,
            isFinished: true,
            needHumanCheck: true,
          });
          if (direction === 'exchange') {
            notifyType = 'error';
            msgNotify = `${config.notifyName} unable to verify exchange transfer of _${sendAmount}_ _${sendCurrency}_ (got _${pay.inAmountMessage}_ _${pay.inCurrency}_ from user). Insufficient balance? **Attention needed**. Tx hash: _${sendTxId}_. Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}${admTxDescription}.`;
            msgSendBack = `I’ve tried to make transfer of _${sendAmount}_ _${sendCurrency}_ to you, but I cannot validate transaction. Tx hash: _${sendTxId}_. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.`;
          } else { // direction === 'back'
            notifyType = 'error';
            msgNotify = `${config.notifyName} unable to verify sent back of _${sendAmount}_ _${sendCurrency}_. Insufficient balance? **Attention needed**. Tx hash: _${sendTxId}_. Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}${admTxDescription}.`;
            msgSendBack = `I’ve tried to send back transfer to you, but I cannot validate transaction. Tx hash: _${sendTxId}_. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.`;
          }
          notify(msgNotify, notifyType);
          api.sendMessage(config.passPhrase, pay.senderId, msgSendBack).then((response) => {
            if (!response.success) {
              log.warn(`Failed to send ADM message '${msgSendBack}' to ${pay.senderId}. ${response.errorMessage}.`);
            }
          });
        }
        pay.save();
        return;
      }

      if (tx.status === false) {

        pay.outTxFailedCounter = ++pay.outTxFailedCounter || 1;
        pay.errorValidatorSend = constants.ERRORS.SENT_TX_FAILED;
        notifyType = 'error';
        let willRetryString; let msgNotifyIntro; let msgSendBackIntro;

        if (direction === 'exchange') {
          msgNotifyIntro = `exchange transfer of _${sendAmount}_ _${sendCurrency}_ (got _${pay.inAmountMessage}_ _${pay.inCurrency}_ from user)`;
          msgSendBackIntro = `I’ve tried to make transfer of _${sendAmount}_ _${sendCurrency}_ to you`;
        } else { // direction === 'back'
          msgNotifyIntro = `sent back of _${sendAmount}_ _${sendCurrency}_`;
          msgSendBackIntro = `I’ve tried to send transfer back`;
        }

        if (exchangerUtils.isEthOrERC20(sendCurrency) && pay.outTxFailedCounter > constants.SENDER_RESEND_ETH_RETRIES) {
          msgSendBack = `${msgSendBackIntro}, but my ${pay.outTxFailedCounter} tries failed. Last try Tx hash: _${sendTxId}_. I’ve already notified my master. If you wouldn’t receive transfer in two days, contact my master also.`;
          willRetryString = 'No retries left. **Attention needed**. ';
          pay.update({
            outTxStatus: tx.status,
            isFinished: true,
            needHumanCheck: true,
          });
        } else {
          if (exchangerUtils.isEthOrERC20(sendCurrency)) {
            willRetryString = `I'll retry ${constants.SENDER_RESEND_ETH_RETRIES - pay.outTxFailedCounter + 1} more times. `;
          } else {
            willRetryString = `I'll try again. `;
          }
          if (direction === 'exchange') {
            pay.outTxid = null;
          } else { // direction === 'back'
            pay.sentBackTx = null;
          }
        }
        msgNotify = `${config.notifyName} notifies that ${msgNotifyIntro} **failed**. Tx hash: _${sendTxId}_. ${willRetryString}Balance of _${sendCurrency}_ is _${exchangerUtils[sendCurrency].balance}_. ${etherString}${admTxDescription}.`;

        await pay.save();
        notify(msgNotify, notifyType);
        if (msgSendBack) {
          api.sendMessage(config.passPhrase, pay.senderId, msgSendBack).then((response) => {
            if (!response.success) {
              log.warn(`Failed to send ADM message '${msgSendBack}' to ${pay.senderId}. ${response.errorMessage}.`);
            }
          });
        }
        return;

      } // if (tx.status === false)

      pay.outTxIsInstant = tx.instantlock && tx.instantlock_internal;
      if (!tx.height && !tx.confirmations && !pay.outTxIsInstant) {
        log.warn(`Unable to get sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} height or confirmations. Will try again next time. ${admTxDescription}.`);
        return;
      }

      let confirmations = tx.confirmations;
      if (!tx.confirmations && tx.height) {
        const lastBlockHeight = await exchangerUtils[sendCurrency].getLastBlockHeight();
        if (!lastBlockHeight) {
          log.warn(`Unable to get last block height for ${sendCurrency} to count Tx ${sendTxId} confirmations in ${utils.getModuleName(module.id)} module. Waiting for next try.`);
          return;
        }
        confirmations = lastBlockHeight - tx.height + 1;
      }

      pay.update({
        outTxStatus: tx.status,
        outConfirmations: confirmations,
      });

      const confirmationsReached = pay.outConfirmations >= 1; // One confirmations is enough for outgoing payments
      if (pay.outTxStatus || confirmationsReached || pay.outTxIsInstant) {

        let confirmationReason;
        if (confirmationsReached) {
          confirmationReason = `, it has 1 network confirmation`;
        } else if (pay.outTxStatus) {
          confirmationReason = `, its status is Success`;
        } else {
          confirmationReason = ` as InstantSend verified. Currently it has ${pay.outConfirmations ? pay.outConfirmations : 0} network confirmations`;
        }
        log.log(`Sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} is confirmed${confirmationReason}. ${admTxDescription}.`);

        if (direction === 'exchange') {
          notifyType = 'info';
          msgNotify = `${config.notifyName} successfully exchanged _${pay.inAmountMessage} ${pay.inCurrency}_ (got from user) for _${pay.outAmount} ${pay.outCurrency}_ (sent to user) with Tx hash: _${sendTxId}_. ${admTxDescription}.`;
          msgSendBack = 'Done! Thank you for business. Hope to see you again.';
        } else { // direction === 'back'
          notifyType = 'log';
          msgNotify = `${config.notifyName} successfully sent back _${sendAmount} ${sendCurrency}_ with Tx hash: _${sendTxId}_. ${admTxDescription}.`;
          msgSendBack = `Here is your refund. Note, I've spent some to cover blockchain fees. Try me again!`;
        }

        if (sendCurrency !== 'ADM') {
          msgSendBack = `{"type":"${sendCurrency.toLowerCase()}_transaction","amount":"${sendAmount}","hash":"${sendTxId}","comments":"${msgSendBack}"}`;
          const message = await api.sendMessage(config.passPhrase, pay.senderId, msgSendBack, 'rich');
          if (message.success) {
            pay.isFinished = true;
          } else {
            log.warn(`Failed to send ADM message on sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} to ${pay.senderId}. I will try again. ${message.errorMessage}.`);
          }
        } else {
          pay.isFinished = true;
          // Don't send ADM message, as if ADM, it is already sent with the payment
        }

      } else {
        log.log(`Updated sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} confirmations: ${pay.outConfirmations}. ${admTxDescription}.`);
      }

      await pay.save();

      if (msgNotify) {
        notify(msgNotify, notifyType);
      }

    } catch (e) {
      log.error(`Failed to check sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency}: ${e.toString()}. Will try again next time. ${admTxDescription}.`);
    }

  });

};

setInterval(() => {
  module.exports();
}, constants.SENDER_TX_INTERVAL);
