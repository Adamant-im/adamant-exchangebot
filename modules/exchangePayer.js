const db = require('./DB');
const config = require('./configReader');
const constants = require('../helpers/const');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const messenger = require('../helpers/messenger');
const utils = require('../helpers/utils');
const { startInterval } = require('../helpers/scheduler');

/** Comment attached to an ADM payout; other coins carry it in the rich message instead. */
const PAYOUT_COMMENT = 'Done! Thank you for your business. Hope to see you again.';

/**
 * Error codes this module stores with a payment.
 *
 * These values are persisted in the `payments` collection and appear in operator
 * notifications, so an existing code must never be reused for a different meaning.
 */
const PAYOUT_ERRORS = {
  INSUFFICIENT_BALANCE: 15,
  UNABLE_TO_SEND: 16,
};

/**
 * Sends the exchange payout for one payment.
 *
 * @param {object} pay Payment document
 * @returns {Promise<void>}
 */
async function payOut(pay) {
  const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay.itxId} from ${pay.senderId}`;

  const { outAmount, inCurrency, outCurrency, senderKvsOutAddress, inAmountMessage } = pay;

  pay.counterSendExchange = ++pay.counterSendExchange || 1;

  log.log(
    `Sending ${outAmount} ${outCurrency} in exchange for ${inAmountMessage} ${inCurrency}. Attempt ${pay.counterSendExchange}… ${admTxDescription}.`,
  );

  const outCurrencyBalance = await exchangerUtils[outCurrency].getBalance();

  if (!utils.isPositiveOrZeroNumber(outCurrencyBalance)) {
    log.warn(
      `Unable to update the ${outCurrency} balance in ${utils.getModuleName(module.id)} module. Waiting for the next try.`,
    );

    return;
  }

  let etherString = '';
  let isNotEnoughBalance;

  if (exchangerUtils.isERC20(outCurrency)) {
    const ethBalance = await exchangerUtils.ETH.getBalance();

    if (!utils.isPositiveOrZeroNumber(ethBalance)) {
      log.warn(
        `Unable to update the ETH balance in ${utils.getModuleName(module.id)} module. Waiting for the next try.`,
      );

      return;
    }

    etherString = `Ether balance: ${ethBalance}. `;
    // An ERC-20 payout moves tokens but pays its fee in ETH, so both must cover it.
    isNotEnoughBalance = outAmount > outCurrencyBalance || exchangerUtils[outCurrency].FEE > ethBalance;
  } else {
    isNotEnoughBalance = outAmount + exchangerUtils[outCurrency].FEE > outCurrencyBalance;
  }

  if (isNotEnoughBalance) {
    await pay.update({ error: PAYOUT_ERRORS.INSUFFICIENT_BALANCE, needToSendBack: true }, true);

    notify(
      `${config.notifyName} has an insufficient balance to exchange _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Will try to send the payment back. The _${outCurrency}_ balance is _${exchangerUtils[outCurrency].balance}_. ${etherString}${admTxDescription}.`,
      'warn',
    );
    await messenger.sendMessage(
      pay.senderId,
      `I can’t transfer _${outAmount}_ _${outCurrency}_ to you because of insufficient funds — I count the blockchain fees as well. Check my balances with the **/balances** command. I’ll send your transfer back to you.`,
    );

    return;
  }

  // Mark the payout as in flight before broadcasting. If anything goes wrong between
  // the broadcast and storing the hash — a crash, or a database write that fails — the
  // marker survives, and reconcileInterrupted() escalates the payment to a human rather
  // than letting a later tick send a second payment.
  await pay.update({ payoutStartedAt: utils.unix() }, true);

  const result = await exchangerUtils[outCurrency].send({
    address: senderKvsOutAddress,
    value: outAmount,
    comment: PAYOUT_COMMENT, // Used for ADM only
    try: pay.outTxFailedCounter + 1,
  });

  if (result.success) {
    await pay.update({ outTxid: result.hash, payoutStartedAt: null }, true);

    // Update the cached balances so the next payout in this batch sees the funds already spent.
    if (exchangerUtils.isERC20(outCurrency)) {
      exchangerUtils[outCurrency].balance -= outAmount;
      exchangerUtils.ETH.balance -= exchangerUtils[outCurrency].FEE;
    } else {
      exchangerUtils[outCurrency].balance -= outAmount + exchangerUtils[outCurrency].FEE;
    }

    return;
  }

  if (result.isAmbiguous) {
    // The transfer may already be in the network. Leaving the in-flight marker in place
    // keeps this payment out of the queue, and reconcileInterrupted() escalates it on the
    // next tick. Retrying here could pay the user twice.
    log.error(
      `Unable to confirm the outcome of the exchange payment of ${outAmount} ${outCurrency}. Leaving it for manual review. ${result.error}. ${admTxDescription}.`,
    );
    await pay.save();

    return;
  }

  await pay.update({ payoutStartedAt: null });

  if (pay.counterSendExchange < constants.EXCHANGER_RETRIES) {
    log.warn(
      `Unable to send the exchange payment of ${inAmountMessage} ${inCurrency} for ${outAmount} ${outCurrency} this time (${pay.counterSendExchange}/${constants.EXCHANGER_RETRIES}). Will try again. ${admTxDescription}.`,
    );
    await pay.save();

    return;
  }

  await pay.update({ error: PAYOUT_ERRORS.UNABLE_TO_SEND, needToSendBack: true }, true);

  notify(
    `${config.notifyName} cannot make the transaction to exchange _${inAmountMessage}_ _${inCurrency}_ for _${outAmount}_ _${outCurrency}_. Will try to send the payment back. The _${outCurrency}_ balance is _${exchangerUtils[outCurrency].balance}_. ${etherString}${admTxDescription}.`,
    'error',
  );
  await messenger.sendMessage(
    pay.senderId,
    `I tried to transfer _${outAmount}_ _${outCurrency}_ to you, but something went wrong. I’ll send your payment back to you.`,
  );
}

/**
 * Pays out every payment that is validated, confirmed and not paid yet.
 *
 * Each payment is handled independently: one that cannot be processed right now is
 * skipped, never allowed to hold up the rest of the queue.
 *
 * @returns {Promise<void>}
 */
async function run() {
  // A payment still carrying the in-flight marker is left over from a broadcast whose
  // outcome was never recorded. Escalate those first, so the selector below can never
  // pick one up and send a second payment.
  await reconcileInterrupted();

  const payouts = await db.paymentsDb.find({
    isBasicChecksPassed: true,
    transactionIsValid: true,
    inTxConfirmed: true,
    isFinished: false,
    transactionIsFailed: false,
    needToSendBack: false,
    needHumanCheck: false,
    outTxid: null,
    payoutStartedAt: null,
  });

  for (const pay of payouts) {
    try {
      await payOut(pay);
    } catch (error) {
      log.error(
        `Error while sending the exchange payment of ${pay.inAmountMessage} ${pay.inCurrency} for ${pay.outAmount} ${pay.outCurrency} in ${utils.getModuleName(module.id)} module. Error: ${error}`,
      );
    }
  }
}

/**
 * Flags payouts that were interrupted mid-broadcast for manual review.
 *
 * A payment left with `payoutStartedAt` set was in flight when the process stopped:
 * the transfer may or may not have reached the network. Retrying it automatically
 * could pay the user twice, so it is escalated to the operator instead.
 *
 * @returns {Promise<void>}
 */
async function reconcileInterrupted() {
  const interrupted = await db.paymentsDb.find({
    payoutStartedAt: { $ne: null },
    outTxid: null,
    isFinished: false,
  });

  for (const pay of interrupted) {
    try {
      await pay.update({ needHumanCheck: true, error: PAYOUT_ERRORS.UNABLE_TO_SEND, payoutStartedAt: null }, true);
    } catch (error) {
      // The marker stays set, which keeps the payment out of the payout queue, so the
      // worst case is that it is escalated on a later tick instead.
      log.error(`Unable to escalate the interrupted payout of payment ${pay._id}. ${error}`);
      continue;
    }

    notify(
      `${config.notifyName} was interrupted while sending _${pay.outAmount}_ _${pay.outCurrency}_ to _${pay.senderKvsOutAddress}_. The payment may or may not have been broadcast. **Attention needed** — check the ${pay.outCurrency} blockchain before doing anything. Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${pay.itxId} from ${pay.senderId}.`,
      'error',
    );
  }
}

/**
 * Starts sending exchange payouts on a timer.
 *
 * @returns {NodeJS.Timeout}
 */
function start() {
  return startInterval('exchange payer', run, constants.EXCHANGER_INTERVAL);
}

module.exports = { payOut, run, reconcileInterrupted, start };
