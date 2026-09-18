const log = require('../helpers/log');
const notify = require('../helpers/notify');
const messenger = require('../helpers/messenger');
const { startInterval } = require('../helpers/scheduler');
const config = require('./configReader');
const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const db = require('./DB');
const api = require('./api');

/**
 * Verifies that the transfer a user announced in chat really happened, and that it
 * happened the way they said it did.
 *
 * This is the security boundary of the bot: everything before it is a claim made by
 * an untrusted chat counterparty. The sender, the recipient, the amount and the
 * timestamp are checked against the coin's own blockchain, and the sender is matched
 * against the address the user published in the ADAMANT KVS — which is what stops one
 * user from claiming somebody else's transfer.
 *
 * @param {object} pay Payment document
 * @param {object} tx ADAMANT transaction that carried the request
 * @returns {Promise<void>}
 */
async function validate(pay, tx) {
  const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${tx?.id} from ${tx?.senderId}`;

  try {
    log.log(`Validating the ${pay.inCurrency} Tx ${pay.inTxid}… ${admTxDescription}.`);

    pay.counterTxDeepValidator = ++pay.counterTxDeepValidator || 0;

    let msgSendBack = false;
    let msgNotify = false;
    let notifyType = 'log';

    // The bot knows the user's ADM address directly; addresses in other blockchains
    // are published by the user in the ADAMANT KVS.
    const senderKvsInAddress =
      pay.senderKvsInAddress ||
      (pay.inCurrency === 'ADM' && tx.senderId) ||
      (await exchangerUtils.getKvsCryptoAddress(pay.inCurrency, tx.senderId));
    const senderKvsOutAddress =
      pay.senderKvsOutAddress ||
      (pay.outCurrency === 'ADM' && tx.senderId) ||
      (await exchangerUtils.getKvsCryptoAddress(pay.outCurrency, tx.senderId));

    await pay.update({ senderKvsInAddress, senderKvsOutAddress });

    if (!senderKvsInAddress) {
      log.warn(
        `Unable to fetch the ${pay.inCurrency} address of ${tx.senderId} from the KVS. Will try next time. ${admTxDescription}.`,
      );
      await pay.save();

      return;
    }

    if (!senderKvsOutAddress && !pay.needToSendBack) {
      log.warn(
        `Unable to fetch the ${pay.outCurrency} address of ${tx.senderId} from the KVS. Will try next time. ${admTxDescription}.`,
      );
      await pay.save();

      return;
    }

    if (senderKvsInAddress === 'none') {
      await pay.update(
        {
          error: constants.ERRORS.NO_IN_KVS_ADDRESS,
          isFinished: true,
          needHumanCheck: true,
        },
        true,
      );

      notify(
        `${config.notifyName} cannot fetch the _${pay.inCurrency}_ address of the sender from the KVS. Attention needed. ${admTxDescription}.`,
        'error',
      );
      await messenger.sendMessage(
        tx.senderId,
        `I can’t get your _${pay.inCurrency}_ address from the ADAMANT KVS. If you think it’s a mistake, contact my master.`,
      );

      return;
    }

    // The payout address comes from user-published KVS data, so it is validated before
    // the bot ever signs a transfer to it.
    const isPayoutAddressValid =
      senderKvsOutAddress !== 'none' && exchangerUtils[pay.outCurrency]?.isValidAddress(senderKvsOutAddress);

    if (!pay.needToSendBack && !isPayoutAddressValid) {
      await pay.update({
        needToSendBack: true,
        error:
          senderKvsOutAddress === 'none'
            ? constants.ERRORS.NO_OUT_KVS_ADDRESS
            : constants.ERRORS.INVALID_PAYOUT_ADDRESS,
      });

      notifyType = 'warn';

      if (senderKvsOutAddress === 'none') {
        msgNotify = `${config.notifyName} cannot fetch the _${pay.outCurrency}_ address of the sender from the KVS. Will try to send the payment back.`;
        msgSendBack = `I can’t get your _${pay.outCurrency}_ address from the ADAMANT KVS. Make sure you use an ADAMANT wallet with _${pay.outCurrency}_ enabled. I’ll validate the transfer and send it back to you. That can take a while, so please be patient.`;
      } else {
        msgNotify = `${config.notifyName} got an invalid _${pay.outCurrency}_ payout address from the KVS: _${senderKvsOutAddress}_. Will try to send the payment back.`;
        msgSendBack = `The _${pay.outCurrency}_ address published in your ADAMANT KVS doesn’t look valid, so I won’t send a payout to it. I’ll validate the transfer and send it back to you instead.`;
      }
    }

    const incomeTx = await exchangerUtils[pay.inCurrency].getTransaction(pay.inTxid);

    if (!incomeTx) {
      if (pay.counterTxDeepValidator < constants.VALIDATOR_GET_TX_RETRIES) {
        await pay.save();
        log.warn(
          `Unable to get the ${pay.inCurrency} Tx ${pay.inTxid} (${pay.counterTxDeepValidator}/${constants.VALIDATOR_GET_TX_RETRIES}). This is expected while the Tx is new. Will try again next time. ${admTxDescription}.`,
        );

        return;
      }

      await pay.update({
        transactionIsValid: false,
        isFinished: true,
        error: constants.ERRORS.UNABLE_TO_FETCH_TX,
      });

      notifyType = 'warn';
      msgNotify = `${config.notifyName} can’t fetch the transaction of _${pay.inAmountMessage} ${pay.inCurrency}_. It may have failed or been cancelled.`;
      msgSendBack = `I can’t find the transaction of _${pay.inAmountMessage} ${pay.inCurrency}_ with Tx ID _${pay.inTxid}_ in the _${pay.inCurrency}_ blockchain. It may have failed or been cancelled. If you think it’s a mistake, contact my master.`;
    } else {
      await pay.update({
        inTxSenderId: incomeTx.senderId,
        inTxRecipientId: incomeTx.recipientId,
        inAmountReal: incomeTx.amount,
        inTxFee: incomeTx.fee,
        inTxStatus: incomeTx.status,
        inTxHeight: incomeTx.height,
        inTxTimestamp: incomeTx.timestamp,
        inTxIsInstant: Boolean(incomeTx.instantlock && incomeTx.instantlock_internal),
        inTxInstantChainlock: incomeTx.chainlock,
        inConfirmations: incomeTx.confirmations,
      });

      if (
        !pay.inTxSenderId ||
        !pay.inTxRecipientId ||
        !pay.inAmountReal ||
        (!pay.inTxTimestamp && !pay.inTxIsInstant)
      ) {
        await pay.save();
        log.warn(
          `Unable to get the full details of the transaction. inTxSenderId: ${pay.inTxSenderId}, inTxRecipientId: ${pay.inTxRecipientId}, inAmountReal: ${pay.inAmountReal}, inTxTimestamp: ${pay.inTxTimestamp}. Will try again next time. Tx hash: ${pay.inTxid}. ${admTxDescription}.`,
        );

        return;
      }

      const deltaAmount = Math.abs(pay.inAmountReal - pay.inAmountMessage);
      // How far the transfer in its own blockchain is from the moment the user announced
      // it in chat. A large gap means the user is pointing at somebody else's old transfer.
      const deltaTimestamp = Math.abs(utils.toTimestamp(tx.timestamp) - pay.inTxTimestamp);

      if (!utils.isStringEqualCI(pay.inTxSenderId, pay.senderKvsInAddress)) {
        await pay.update({
          transactionIsValid: false,
          isFinished: true,
          error: constants.ERRORS.WRONG_SENDER,
        });

        notifyType = 'error';
        msgNotify = `${config.notifyName} considers the transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ to be wrong. Expected sender: _${senderKvsInAddress}_, actual sender: _${pay.inTxSenderId}_.`;
        msgSendBack = `I can’t validate the transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
      } else if (!utils.isStringEqualCI(pay.inTxRecipientId, exchangerUtils[pay.inCurrency].account.address)) {
        await pay.update({
          transactionIsValid: false,
          isFinished: true,
          error: constants.ERRORS.WRONG_RECIPIENT,
        });

        notifyType = 'error';
        msgNotify = `${config.notifyName} considers the transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ to be wrong. Expected recipient: _${exchangerUtils[pay.inCurrency].account.address}_, actual recipient: _${pay.inTxRecipientId}_.`;
        msgSendBack = `I can’t validate the transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
      } else if (deltaAmount > pay.inAmountReal * constants.VALIDATOR_AMOUNT_DEVIATION) {
        await pay.update({
          transactionIsValid: false,
          isFinished: true,
          error: constants.ERRORS.WRONG_AMOUNT,
        });

        notifyType = 'error';
        msgNotify = `${config.notifyName} considers the transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ to be wrong. Expected amount: _${pay.inAmountMessage}_, actual amount: _${pay.inAmountReal}_.`;
        msgSendBack = `I can’t validate the transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
      } else if (pay.inTxTimestamp && deltaTimestamp > constants.VALIDATOR_TIMESTAMP_DEVIATION) {
        await pay.update({
          transactionIsValid: false,
          isFinished: true,
          error: constants.ERRORS.WRONG_TIMESTAMP,
        });

        notifyType = 'error';
        msgNotify = `${config.notifyName} considers the transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ to be wrong. The Tx is _${(deltaTimestamp / constants.HOUR).toFixed(0)}_ hours away from the in-chat message.`;
        msgSendBack = `I can’t validate the transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_. If you think it’s a mistake, contact my master.`;
      } else {
        await pay.update({ transactionIsValid: true });
      }
    }

    await pay.save();

    if (msgSendBack) {
      notify(`${msgNotify} Tx hash: _${pay.inTxid}_. ${admTxDescription}.`, notifyType);
      await messenger.sendMessage(tx.senderId, msgSendBack);
    }
  } catch (error) {
    log.error(`Failed to validate the Tx ${pay?.inTxid}: ${error}. Will try again next time. ${admTxDescription}.`);
  }
}

/**
 * Validates every payment that has passed the basic checks but is not verified yet.
 *
 * @returns {Promise<void>}
 */
async function run() {
  const payments = await db.paymentsDb.find({
    transactionIsValid: null,
    isBasicChecksPassed: true,
    isFinished: false,
  });

  for (const pay of payments) {
    const response = await api.getTransaction(pay.admTxId);

    if (!response.success) {
      log.warn(
        `Unable to fetch the ADM Tx ${pay.admTxId} in ${utils.getModuleName(module.id)} module. ${response.errorMessage}.`,
      );
      continue;
    }

    await validate(pay, response.transaction);
  }
}

/**
 * Starts validating incoming transfers on a timer.
 *
 * @returns {NodeJS.Timeout}
 */
function start() {
  return startInterval('deep exchange validator', run, constants.VALIDATOR_TX_INTERVAL);
}

module.exports = { validate, run, start };
