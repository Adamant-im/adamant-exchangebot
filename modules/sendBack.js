const db = require('./DB');
const config = require('./configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const messenger = require('../helpers/messenger');
const constants = require('../helpers/const');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const utils = require('../helpers/utils');
const { startInterval } = require('../helpers/scheduler');

/** Comment attached to an ADM refund; other coins carry it in the rich message instead. */
const REFUND_COMMENT = 'Here is your refund. Note that some of it covered the blockchain fees. Try me again!';

/**
 * Error codes this module stores with a payment, in its `errorSendBack` field.
 *
 * These values are persisted in the `payments` collection and appear in operator
 * notifications, so an existing code must never be reused for a different meaning.
 */
const REFUND_ERRORS = {
  DOES_NOT_COVER_FEE: 17,
  INSUFFICIENT_BALANCE: 18,
  UNABLE_TO_SEND: 19,
};

/**
 * Refunds one payment the bot could not exchange.
 *
 * The refund is the incoming amount minus the network fee of sending it back: the
 * user pays the cost of the transfer they asked for, and the bot does not subsidize
 * it out of another user's funds.
 *
 * @param {object} pay Payment document
 * @returns {Promise<void>}
 */
async function refund(pay) {
  const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay.itxId} from ${pay.senderId}`;
  const { inAmountReal, inCurrency, senderKvsInAddress } = pay;

  pay.counterSendBack = ++pay.counterSendBack || 1;

  log.log(`Sending back ${inAmountReal} ${inCurrency}. Attempt ${pay.counterSendBack}… ${admTxDescription}.`);

  const outFee = exchangerUtils[inCurrency].FEE;
  const inCurrencyBalance = await exchangerUtils[inCurrency].getBalance();

  if (!utils.isPositiveOrZeroNumber(inCurrencyBalance)) {
    log.warn(
      `Unable to update the ${inCurrency} balance in ${utils.getModuleName(module.id)} module. Waiting for the next try.`,
    );

    return;
  }

  let etherString = '';
  let isNotEnoughBalance;
  let sentBackAmount;

  if (exchangerUtils.isERC20(inCurrency)) {
    const ethBalance = await exchangerUtils.ETH.getBalance();

    if (!utils.isPositiveOrZeroNumber(ethBalance)) {
      log.warn(
        `Unable to update the ETH balance in ${utils.getModuleName(module.id)} module. Waiting for the next try.`,
      );

      return;
    }

    etherString = `Ether balance: ${ethBalance}. `;

    // The fee is paid in ETH, but it is deducted from the token the user gets back.
    const feeInToken = exchangerUtils.convertCryptos('ETH', inCurrency, outFee).outAmount;

    sentBackAmount = Number((inAmountReal - feeInToken).toFixed(constants.PRECISION_DECIMALS));
    isNotEnoughBalance = sentBackAmount > inCurrencyBalance || outFee > ethBalance;
  } else {
    sentBackAmount = Number((inAmountReal - outFee).toFixed(constants.PRECISION_DECIMALS));
    isNotEnoughBalance = sentBackAmount + outFee > inCurrencyBalance;
  }

  const sentBackAmountUsd = exchangerUtils.convertCryptos(inCurrency, 'USD', sentBackAmount).outAmount;

  await pay.update({ outFee, sentBackAmount, sentBackAmountUsd });

  let msgSendBack = false;
  let msgNotify = false;
  let notifyType = 'log';

  if (!utils.isPositiveNumber(sentBackAmount)) {
    await pay.update({ errorSendBack: REFUND_ERRORS.DOES_NOT_COVER_FEE, isFinished: true });

    notifyType = 'log';
    msgNotify = `${config.notifyName} won’t send back the payment of _${inAmountReal}_ _${inCurrency}_, because it does not cover the transaction fee. ${admTxDescription}.`;
    msgSendBack =
      'I can’t send the transfer back to you because it does not cover the blockchain fees. If you think it’s a mistake, contact my master.';
  } else if (isNotEnoughBalance) {
    await pay.update({ errorSendBack: REFUND_ERRORS.INSUFFICIENT_BALANCE, needHumanCheck: true, isFinished: true });

    notifyType = 'error';
    msgNotify = `${config.notifyName} has an insufficient balance to send back _${inAmountReal}_ _${inCurrency}_. **Attention needed**. The _${inCurrency}_ balance is _${exchangerUtils[inCurrency].balance}_. ${etherString}${admTxDescription}.`;
    msgSendBack =
      'I can’t send the transfer back to you because of an insufficient balance. I’ve already notified my master. If you don’t receive the transfer within two days, contact my master as well.';
  } else {
    // Mark the refund as in flight before broadcasting; see exchangePayer.reconcileInterrupted().
    await pay.update({ sendBackStartedAt: utils.unix() }, true);

    const result = await exchangerUtils[inCurrency].send({
      address: senderKvsInAddress,
      value: sentBackAmount,
      comment: REFUND_COMMENT, // Used for ADM only
      try: pay.outTxFailedCounter + 1,
    });

    if (result.success) {
      // Persist the hash immediately. Any gap between the broadcast and the write is a
      // window in which a crash would leave the refund unrecorded.
      await pay.update({ sentBackTx: result.hash, sendBackStartedAt: null }, true);

      exchangerUtils[inCurrency].balance -= sentBackAmount;

      if (exchangerUtils.isERC20(inCurrency)) {
        exchangerUtils.ETH.balance -= outFee;
      }
    } else if (result.isAmbiguous) {
      // The refund may already be in the network. Leaving the in-flight marker in place
      // keeps this payment out of the queue, and reconcileInterrupted() escalates it on
      // the next tick. Retrying here could refund the user twice.
      log.error(
        `Unable to confirm the outcome of the refund of ${sentBackAmount} ${inCurrency}. Leaving it for manual review. ${result.error}. ${admTxDescription}.`,
      );
      await pay.save();

      return;
    } else {
      await pay.update({ sendBackStartedAt: null });

      if (pay.counterSendBack < constants.SENDBACK_RETRIES) {
        log.warn(
          `Unable to send back ${sentBackAmount} ${inCurrency} this time (${pay.counterSendBack}/${constants.SENDBACK_RETRIES}). Will try again. ${admTxDescription}.`,
        );
        await pay.save();

        return;
      }

      await pay.update({ errorSendBack: REFUND_ERRORS.UNABLE_TO_SEND, needHumanCheck: true, isFinished: true });

      notifyType = 'error';
      msgNotify = `${config.notifyName} cannot make the transaction to send back _${sentBackAmount}_ _${inCurrency}_. **Attention needed**. The _${inCurrency}_ balance is _${exchangerUtils[inCurrency].balance}_. ${etherString}${admTxDescription}.`;
      msgSendBack =
        'I tried to send the transfer back to you, but something went wrong. I’ve already notified my master. If you don’t receive the transfer within two days, contact my master as well.';
    }
  }

  await pay.save();

  if (msgNotify) {
    notify(msgNotify, notifyType);
  }

  if (msgSendBack) {
    await messenger.sendMessage(pay.senderId, msgSendBack);
  }
}

/**
 * Refunds every payment that is marked for a send-back and has not been refunded yet.
 *
 * @returns {Promise<void>}
 */
async function run() {
  // A payment still carrying the in-flight marker is left over from a broadcast whose
  // outcome was never recorded. Escalate those first, so the selector below can never
  // pick one up and send a second refund.
  await reconcileInterrupted();

  const payments = await db.paymentsDb.find({
    isBasicChecksPassed: true,
    transactionIsValid: true,
    inTxConfirmed: true,
    isFinished: false,
    transactionIsFailed: false,
    needToSendBack: true,
    needHumanCheck: false,
    outTxid: null,
    sentBackTx: null,
    sendBackStartedAt: null,
  });

  for (const pay of payments) {
    try {
      await refund(pay);
    } catch (error) {
      log.error(
        `Error while sending back ${pay.inAmountReal} ${pay.inCurrency} in ${utils.getModuleName(module.id)} module. Error: ${error}`,
      );
    }
  }
}

/**
 * Flags refunds that were interrupted mid-broadcast for manual review.
 *
 * @returns {Promise<void>}
 */
async function reconcileInterrupted() {
  const interrupted = await db.paymentsDb.find({
    sendBackStartedAt: { $ne: null },
    sentBackTx: null,
    isFinished: false,
  });

  for (const pay of interrupted) {
    try {
      await pay.update(
        { needHumanCheck: true, errorSendBack: REFUND_ERRORS.UNABLE_TO_SEND, sendBackStartedAt: null },
        true,
      );
    } catch (error) {
      // The marker stays set, which keeps the payment out of the refund queue, so the
      // worst case is that it is escalated on a later tick instead.
      log.error(`Unable to escalate the interrupted refund of payment ${pay._id}. ${error}`);
      continue;
    }

    notify(
      `${config.notifyName} was interrupted while sending back _${pay.sentBackAmount}_ _${pay.inCurrency}_ to _${pay.senderKvsInAddress}_. The refund may or may not have been broadcast. **Attention needed** — check the ${pay.inCurrency} blockchain before doing anything. Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay.itxId} from ${pay.senderId}.`,
      'error',
    );
  }
}

/**
 * Starts sending refunds on a timer.
 *
 * @returns {NodeJS.Timeout}
 */
function start() {
  return startInterval('send back', run, constants.SENDBACK_INTERVAL);
}

module.exports = { refund, run, reconcileInterrupted, start };
