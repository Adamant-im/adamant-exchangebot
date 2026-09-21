const db = require('./DB');
const config = require('./configReader');
const constants = require('../helpers/const');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const messenger = require('../helpers/messenger');
const utils = require('../helpers/utils');
const { startInterval } = require('../helpers/scheduler');
const { ensureSupportedCoin } = require('./unsupportedCoinGuard');

/**
 * Describes the transfer the bot made for a payment — either the exchange payout or
 * the refund, whichever is outstanding.
 *
 * @param {object} pay Payment document
 * @returns {{direction: 'exchange'|'back', sendCurrency: string, sendTxId: string, sendAmount: number}}
 */
function describeSentTx(pay) {
  if (pay.outTxid) {
    return {
      direction: 'exchange',
      sendCurrency: pay.outCurrency,
      sendTxId: pay.outTxid,
      sendAmount: pay.outAmount,
    };
  }

  return {
    direction: 'back',
    sendCurrency: pay.inCurrency,
    sendTxId: pay.sentBackTx,
    sendAmount: pay.sentBackAmount,
  };
}

/**
 * Handles a transfer the bot sent that cannot be found in its blockchain.
 *
 * A freshly broadcast transfer is often not visible yet, so this only escalates once
 * the retries are exhausted — at which point a human has to check whether the funds
 * actually left.
 *
 * @param {object} pay Payment document
 * @param {object} sent Details from {@link describeSentTx}
 * @param {string} etherString Ether balance note, for ERC-20 payouts
 * @param {string} admTxDescription Link to the originating ADAMANT transaction
 * @returns {Promise<void>}
 */
async function handleMissingTx(pay, sent, etherString, admTxDescription) {
  const { direction, sendCurrency, sendTxId, sendAmount } = sent;

  log.warn(
    `Unable to fetch the sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} (${pay.tryCounterCheckOutTX}/${constants.SENDER_GET_TX_RETRIES}). This is expected while the Tx is new. Will try again next time. ${admTxDescription}.`,
  );

  if (pay.tryCounterCheckOutTX <= constants.SENDER_GET_TX_RETRIES) {
    await pay.save();

    return;
  }

  await pay.update({
    errorCheckOuterTX: constants.ERRORS.UNABLE_TO_FETCH_SENT_TX,
    isFinished: true,
    needHumanCheck: true,
  });

  const balanceInfo = `The _${sendCurrency}_ balance is _${exchangerUtils[sendCurrency].balance}_. ${etherString}`;

  if (direction === 'exchange') {
    notify(
      `${config.notifyName} is unable to verify the exchange transfer of _${sendAmount}_ _${sendCurrency}_ (got _${pay.inAmountMessage}_ _${pay.inCurrency}_ from the user). Insufficient balance? **Attention needed**. Tx hash: _${sendTxId}_. ${balanceInfo}${admTxDescription}.`,
      'error',
    );
    await messenger.sendMessage(
      pay.senderId,
      `I tried to transfer _${sendAmount}_ _${sendCurrency}_ to you, but I can’t validate the transaction. Tx hash: _${sendTxId}_. I’ve already notified my master. If you don’t receive the transfer within two days, contact my master as well.`,
    );
  } else {
    notify(
      `${config.notifyName} is unable to verify the refund of _${sendAmount}_ _${sendCurrency}_. Insufficient balance? **Attention needed**. Tx hash: _${sendTxId}_. ${balanceInfo}${admTxDescription}.`,
      'error',
    );
    await messenger.sendMessage(
      pay.senderId,
      `I tried to send the transfer back to you, but I can’t validate the transaction. Tx hash: _${sendTxId}_. I’ve already notified my master. If you don’t receive the transfer within two days, contact my master as well.`,
    );
  }

  await pay.save();
}

/**
 * Handles a transfer the bot sent that the blockchain reports as failed.
 *
 * Clearing the stored hash puts the payment back in the payout or refund queue, so
 * it is retried. Ethereum and ERC-20 transfers get a limited number of retries,
 * because a repeated failure there usually means the gas limit is too low and every
 * attempt burns gas.
 *
 * @param {object} pay Payment document
 * @param {object} sent Details from {@link describeSentTx}
 * @param {string} etherString Ether balance note, for ERC-20 payouts
 * @param {string} admTxDescription Link to the originating ADAMANT transaction
 * @param {boolean|undefined} status Reported transaction status
 * @returns {Promise<void>}
 */
async function handleFailedTx(pay, sent, etherString, admTxDescription, status) {
  const { direction, sendCurrency, sendTxId, sendAmount } = sent;

  pay.outTxFailedCounter = ++pay.outTxFailedCounter || 1;
  pay.errorValidatorSend = constants.ERRORS.SENT_TX_FAILED;

  const isEthLike = exchangerUtils.isEthOrERC20(sendCurrency);
  const noRetriesLeft = isEthLike && pay.outTxFailedCounter > constants.SENDER_RESEND_ETH_RETRIES;

  const notifyIntro =
    direction === 'exchange'
      ? `the exchange transfer of _${sendAmount}_ _${sendCurrency}_ (got _${pay.inAmountMessage}_ _${pay.inCurrency}_ from the user)`
      : `the refund of _${sendAmount}_ _${sendCurrency}_`;
  const sendBackIntro =
    direction === 'exchange'
      ? `I tried to transfer _${sendAmount}_ _${sendCurrency}_ to you`
      : 'I tried to send the transfer back to you';

  let willRetryString;
  let msgSendBack = null;

  if (noRetriesLeft) {
    willRetryString = 'No retries left. **Attention needed**. ';
    msgSendBack = `${sendBackIntro}, but my ${pay.outTxFailedCounter} attempts failed. Last attempt Tx hash: _${sendTxId}_. I’ve already notified my master. If you don’t receive the transfer within two days, contact my master as well.`;

    await pay.update({ outTxStatus: status, isFinished: true, needHumanCheck: true });
  } else {
    willRetryString = isEthLike
      ? `I’ll retry ${constants.SENDER_RESEND_ETH_RETRIES - pay.outTxFailedCounter + 1} more times. `
      : 'I’ll try again. ';

    if (direction === 'exchange') {
      pay.outTxid = null;
    } else {
      pay.sentBackTx = null;
    }
  }

  await pay.save();

  notify(
    `${config.notifyName} reports that ${notifyIntro} **failed**. Tx hash: _${sendTxId}_. ${willRetryString}The _${sendCurrency}_ balance is _${exchangerUtils[sendCurrency].balance}_. ${etherString}${admTxDescription}.`,
    'error',
  );

  if (msgSendBack) {
    await messenger.sendMessage(pay.senderId, msgSendBack);
  }
}

/**
 * Checks the status of the transfer the bot sent for one payment, and closes the
 * deal once it is confirmed.
 *
 * @param {object} pay Payment document
 * @returns {Promise<void>}
 */
async function check(pay) {
  const sent = describeSentTx(pay);
  const { direction, sendCurrency, sendTxId, sendAmount } = sent;
  const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay.admTxId} from ${pay.senderId}`;

  pay.tryCounterCheckOutTX = ++pay.tryCounterCheckOutTX || 1;

  if (
    !(await ensureSupportedCoin(pay, {
      coin: sendCurrency,
      stage: 'checking a sent transfer',
      admTxDescription,
      errorField: 'errorCheckOuterTX',
    }))
  ) {
    return;
  }

  const etherString = exchangerUtils.isERC20(sendCurrency) ? `Ether balance: ${exchangerUtils.ETH.balance}. ` : '';

  log.log(
    `Updating the status and confirmations of the sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency}… ${admTxDescription}.`,
  );

  const tx = await exchangerUtils[sendCurrency].getTransaction(sendTxId);

  if (!tx) {
    await handleMissingTx(pay, sent, etherString, admTxDescription);

    return;
  }

  if (tx.status === false) {
    await handleFailedTx(pay, sent, etherString, admTxDescription, tx.status);

    return;
  }

  pay.outTxIsInstant = Boolean(tx.instantlock && tx.instantlock_internal);

  if (!tx.height && !tx.confirmations && !pay.outTxIsInstant) {
    log.warn(
      `Unable to get the height or confirmations of the sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency}. Will try again next time. ${admTxDescription}.`,
    );

    return;
  }

  let confirmations = tx.confirmations;

  if (!confirmations && tx.height) {
    const lastBlockHeight = await exchangerUtils[sendCurrency].getLastBlockHeight();

    if (!lastBlockHeight) {
      log.warn(
        `Unable to get the last ${sendCurrency} block height to count the confirmations of the Tx ${sendTxId} in ${utils.getModuleName(module.id)} module. Waiting for the next try.`,
      );

      return;
    }

    confirmations = lastBlockHeight - tx.height + 1;
  }

  await pay.update({ outTxStatus: tx.status, outConfirmations: confirmations });

  // One confirmation is enough for an outgoing payment: the bot only needs to know
  // that the network accepted it.
  const confirmationsReached = pay.outConfirmations >= 1;

  if (!pay.outTxStatus && !confirmationsReached && !pay.outTxIsInstant) {
    log.log(
      `Updated the confirmations of the sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency}: ${pay.outConfirmations}. ${admTxDescription}.`,
    );
    await pay.save();

    return;
  }

  let confirmationReason;

  if (confirmationsReached) {
    confirmationReason = ', it has 1 network confirmation';
  } else if (pay.outTxStatus) {
    confirmationReason = ', its status is Success';
  } else {
    confirmationReason = ` as InstantSend-locked. It currently has ${pay.outConfirmations || 0} network confirmations`;
  }

  log.log(
    `The sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} is confirmed${confirmationReason}. ${admTxDescription}.`,
  );

  let notifyType;
  let msgNotify;
  let msgSendBack;

  if (direction === 'exchange') {
    notifyType = 'info';
    msgNotify = `${config.notifyName} successfully exchanged _${pay.inAmountMessage} ${pay.inCurrency}_ (got from the user) for _${pay.outAmount} ${pay.outCurrency}_ (sent to the user) with Tx hash: _${sendTxId}_. ${admTxDescription}.`;
    msgSendBack = 'Done! Thank you for your business. Hope to see you again.';
  } else {
    notifyType = 'log';
    msgNotify = `${config.notifyName} successfully sent back _${sendAmount} ${sendCurrency}_ with Tx hash: _${sendTxId}_. ${admTxDescription}.`;
    msgSendBack = 'Here is your refund. Note that some of it covered the blockchain fees. Try me again!';
  }

  if (sendCurrency === 'ADM') {
    // An ADM payout carries its message with the transfer itself, so there is nothing
    // more to send.
    pay.isFinished = true;
  } else {
    const isSent = await messenger.sendTransferMessage(pay.senderId, sendCurrency, sendAmount, sendTxId, msgSendBack);

    if (isSent) {
      pay.isFinished = true;
    } else {
      log.warn(
        `Failed to send the ADM message about the sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency} to ${pay.senderId}. Will try again.`,
      );
    }
  }

  await pay.save();

  notify(msgNotify, notifyType);
}

/**
 * Checks every payment that has an outgoing transfer which is not confirmed yet.
 *
 * @returns {Promise<void>}
 */
async function run() {
  const payments = await db.paymentsDb.find({
    $and: [{ isFinished: false }, { $or: [{ outTxid: { $ne: null } }, { sentBackTx: { $ne: null } }] }],
  });

  for (const pay of payments) {
    try {
      await check(pay);
    } catch (error) {
      const { direction, sendCurrency, sendTxId, sendAmount } = describeSentTx(pay);

      log.error(
        `Failed to check the sent ${direction} Tx ${sendTxId} of ${sendAmount} ${sendCurrency}: ${error}. Will try again next time.`,
      );
    }
  }
}

/**
 * Starts checking sent transfers on a timer.
 *
 * @returns {NodeJS.Timeout}
 */
function start() {
  return startInterval('sent Tx checker', run, constants.SENDER_TX_INTERVAL);
}

module.exports = { check, run, start };
