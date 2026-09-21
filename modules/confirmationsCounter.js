const config = require('./configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const messenger = require('../helpers/messenger');
const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const db = require('./DB');
const { startInterval } = require('../helpers/scheduler');
const { ensureSupportedCoin } = require('./unsupportedCoinGuard');
const depositClaims = require('./depositClaims');

/**
 * Tracks how many confirmations a validated incoming transfer has.
 *
 * A payout is only made once the incoming transfer is buried deep enough that it
 * cannot be reversed — `min_confirmations`, or the coin's own instant-settlement
 * guarantee where it has one.
 *
 * @param {object} pay Payment document
 * @returns {Promise<void>}
 */
async function count(pay) {
  const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay?.admTxId} from ${pay?.senderId}`;

  try {
    log.log(`Updating the confirmations of the incoming Tx ${pay.inTxid}… ${admTxDescription}.`);

    if (
      !(await ensureSupportedCoin(pay, { coin: pay.inCurrency, stage: 'counting confirmations', admTxDescription }))
    ) {
      return;
    }

    const tx = await exchangerUtils[pay.inCurrency].getTransaction(pay.inTxid);

    if (!tx) {
      log.warn(`Unable to fetch the validated Tx ${pay.inTxid}. Will try again next time. ${admTxDescription}.`);

      return;
    }

    if (tx.status === false) {
      await pay.update(
        {
          error: constants.ERRORS.TX_FAILED,
          transactionIsFailed: true,
          isFinished: true,
          inTxConfirmed: false,
        },
        true,
      );

      // The validator settled this claim as eligible when the transfer still looked
      // good — a reorganization can revert it afterwards. Close the claim once the
      // payment's failed state is stored, never before.
      try {
        await depositClaims.setClaimStatus(pay._id, depositClaims.CLAIM_STATUS.INELIGIBLE, { reason: 'tx-failed' });
      } catch (error) {
        // The payment is already finished and will not be picked up again, so this is
        // the only attempt. Log it for the operator, and still report the failed transfer.
        log.error(`Unable to close the deposit claim of the failed payment ${pay._id}. ${error}`);
      }

      notify(
        `${config.notifyName} reports that the transaction _${pay.inTxid}_ of _${pay.inAmountMessage}_ _${pay.inCurrency}_ has failed. ${admTxDescription}.`,
        'error',
      );
      await messenger.sendMessage(
        pay.senderId,
        `The transaction of _${pay.inAmountMessage}_ _${pay.inCurrency}_ with Tx ID _${pay.inTxid}_ has failed and will not be processed. Check the _${pay.inCurrency}_ blockchain explorer and try again. If you think it’s a mistake, contact my master.`,
      );

      return;
    }

    if (!tx.height && !tx.confirmations && !pay.inTxIsInstant) {
      log.warn(
        `Unable to get the height or confirmations of the Tx ${pay.inTxid}. Will try again next time. ${admTxDescription}.`,
      );

      return;
    }

    let confirmations = tx.confirmations;

    // Some nodes report only the block height; derive the confirmations from the chain tip.
    if (!confirmations && tx.height) {
      const lastBlockHeight = await exchangerUtils[pay.inCurrency].getLastBlockHeight();

      if (!lastBlockHeight) {
        log.warn(
          `Unable to get the last ${pay.inCurrency} block height to count the confirmations of the Tx ${pay.inTxid} in ${utils.getModuleName(module.id)} module. Waiting for the next try.`,
        );

        return;
      }

      confirmations = lastBlockHeight - tx.height + 1;
    }

    await pay.update({
      inTxStatus: tx.status,
      inConfirmations: confirmations,
    });

    // The per-coin value is filled in for every coin in `known_crypto`; the fallback only
    // matters for a payment stored before that coin was removed from the config, where an
    // `undefined` threshold would silently never be reached.
    const minConfirmations = config[`min_confirmations_${pay.inCurrency}`] ?? config.min_confirmations;

    if (pay.inTxStatus && pay.inConfirmations >= minConfirmations) {
      pay.inTxConfirmed = true;
      log.log(
        `The Tx ${pay.inTxid} is confirmed: it has reached the minimum of ${minConfirmations} network confirmations. ${admTxDescription}.`,
      );
    } else if (pay.inTxIsInstant) {
      pay.inTxConfirmed = true;
      log.log(
        `The Tx ${pay.inTxid} is confirmed as InstantSend-locked. It currently has ${pay.inConfirmations || 0} network confirmations. ${admTxDescription}.`,
      );
    } else {
      log.log(
        `Updated the confirmations of the Tx ${pay.inTxid}: ${pay.inConfirmations >= 0 ? pay.inConfirmations : 0}. ${admTxDescription}.`,
      );
    }

    await pay.save();
  } catch (error) {
    log.error(
      `Failed to get the confirmations of the Tx ${pay?.inTxid}: ${error}. Will try again next time. ${admTxDescription}.`,
    );
  }
}

/**
 * Updates the confirmations of every validated transfer that is not confirmed yet.
 *
 * @returns {Promise<void>}
 */
async function run() {
  const payments = await db.paymentsDb.find({
    isBasicChecksPassed: true,
    transactionIsValid: true,
    isFinished: false,
    transactionIsFailed: false,
    inTxConfirmed: { $ne: true },
  });

  for (const pay of payments) {
    await count(pay);
  }
}

/**
 * Starts counting confirmations on a timer.
 *
 * @returns {NodeJS.Timeout}
 */
function start() {
  return startInterval('confirmations counter', run, constants.CONFIRMATIONS_INTERVAL);
}

module.exports = { count, run, start };
