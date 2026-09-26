const { decodeMessage } = require('adamant-api');

const db = require('./DB');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const messenger = require('../helpers/messenger');
const utils = require('../helpers/utils');
const config = require('./configReader');
const constants = require('../helpers/const');
const exchangeTxs = require('./exchangeTxs');
const commandTxs = require('./commandTxs');
const unknownTxs = require('./unknownTxs');
const depositClaims = require('./depositClaims');
const Store = require('./Store');
const api = require('./api');
const { withSenderLock } = require('../helpers/mutex');

/** Messages from one user per 24 hours above which the user is treated as a spammer. */
const SPAM_THRESHOLD_PER_DAY = 65;

/** Stored incoming records that never finished are retried after this long. */
const REPLAY_DELAY = 2 * 60 * 1000;

/** Attempts at finishing a stored incoming record before the operator is asked to. */
const MAX_REPLAY_ATTEMPTS = 5;

/**
 * Transactions whose handler is running in this process right now.
 *
 * The same transaction can arrive over the socket and from the REST poller at the same
 * moment, and the replay sweep can pick up a record whose handler is still working.
 * Whoever registers a transaction here first handles it; the others skip it.
 *
 * @type {Set<string>}
 */
const inFlightTxs = new Set();

/** How long a processed transaction stays in the in-memory cache. */
const PROCESSED_TX_TTL = constants.DAY;

/**
 * Transactions already handled in this process.
 *
 * The same transaction arrives twice — once over the socket and once from the REST
 * poller — so this is the first line of de-duplication; the database is the second.
 *
 * @type {Map<string, {updated: number, height: number|undefined}>}
 */
const processedTxs = new Map();

/**
 * Drops cache entries that are older than {@link PROCESSED_TX_TTL}.
 *
 * The bot runs unattended for months, and an unbounded cache is a slow memory leak.
 * Anything evicted here is still de-duplicated against the database.
 */
function pruneProcessedTxs() {
  const cutoff = utils.unix() - PROCESSED_TX_TTL;

  for (const [txid, entry] of processedTxs) {
    if (entry.updated < cutoff) {
      processedTxs.delete(txid);
    }
  }
}

/**
 * Records that a transaction has been seen, and stores its block details once it is mined.
 *
 * Transactions delivered over the socket have no height yet; the REST poller sees
 * the same transaction later with one, which is what advances the "last processed
 * block" marker.
 *
 * @param {object} tx ADAMANT transaction
 * @param {object|null} [itx] Stored incoming-transaction document, when the caller already has it
 * @param {boolean} [updateDb] Write the block details to the stored document
 * @returns {Promise<void>}
 */
async function updateProcessedTx(tx, itx, updateDb) {
  processedTxs.set(tx.id, { updated: utils.unix(), height: tx.height });
  pruneProcessedTxs();

  if (updateDb) {
    // Stored records use the transaction ID as their `_id`, which is always indexed.
    const document = itx ?? (await db.incomingTxsDb.findOne({ _id: tx.id }));

    if (document) {
      await document.update(
        {
          blockId: tx.blockId,
          height: tx.height,
          block_timestamp: tx.block_timestamp,
          confirmations: tx.confirmations,
        },
        true,
      );
    }
  }

  await Store.updateLastProcessedBlockHeight(tx.height);
}

/**
 * Decrypts the in-chat message of a transaction.
 *
 * @param {object} tx ADAMANT transaction
 * @returns {string} The decrypted message, or an empty string for a plain transfer
 */
function decryptMessage(tx) {
  const chat = tx.asset?.chat;

  if (!chat) {
    return '';
  }

  try {
    return decodeMessage(chat.message, tx.senderPublicKey, config.passPhrase, chat.own_message).trim();
  } catch (error) {
    log.warn(`Unable to decrypt the message of Tx ${tx.id} from ${tx.senderId}. ${error}.`);

    return '';
  }
}

/**
 * Handles one incoming ADAMANT transaction: de-duplicates it, classifies it,
 * stores it, and routes it to the module that knows what to do with it.
 *
 * @param {object} tx ADAMANT transaction
 * @returns {Promise<void>}
 */
module.exports = async (tx) => {
  // The socket subscribes to activity around the bot address, which includes the
  // bot's own outgoing messages. Only transactions addressed to the bot belong to
  // the incoming pipeline.
  if (tx.recipientId !== config.address || tx.senderId === config.address) {
    return;
  }

  // The check and the registration must happen before the first `await`: nothing can
  // interleave with them, so a second arrival of the same transaction always sees the
  // first one. The de-duplication below reads the database, which only catches a
  // transaction whose record is already stored.
  if (inFlightTxs.has(tx.id)) {
    return;
  }

  inFlightTxs.add(tx.id);

  try {
    await handleIncomingTx(tx);
  } finally {
    inFlightTxs.delete(tx.id);
  }
};

/**
 * Handles one incoming transaction that no other handler in this process is working on.
 *
 * @param {object} tx ADAMANT transaction
 * @returns {Promise<void>}
 */
async function handleIncomingTx(tx) {
  const cached = processedTxs.get(tx.id);

  if (cached) {
    if (!cached.height) {
      await updateProcessedTx(tx, null, true);
    }

    return;
  }

  const { incomingTxsDb, paymentsDb } = db;
  const knownTx = await incomingTxsDb.findOne({ _id: tx.id });

  if (knownTx !== null) {
    if (!knownTx.height) {
      await updateProcessedTx(tx, knownTx, true);
    } else {
      processedTxs.set(tx.id, { updated: utils.unix(), height: tx.height });
    }

    return;
  }

  log.log(`Processing new incoming transaction ${tx.id} from ${tx.senderId} via ${tx.height ? 'REST' : 'socket'}…`);

  const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${tx.id} from ${tx.senderId}`;

  let decryptedMessage = decryptMessage(tx);
  let commandFix = '';

  // Users often type a command without the leading slash; accept the most common ones.
  if (decryptedMessage.toLowerCase() === 'help') {
    decryptedMessage = '/help';
    commandFix = 'help';
  }

  if (decryptedMessage.toLowerCase() === '/balance') {
    decryptedMessage = '/balances';
    commandFix = 'balance';
  }

  if (decryptedMessage.toLowerCase() === 'cancel') {
    decryptedMessage = '/cancel';
    commandFix = 'cancel';
  }

  // A transfer of a coin other than ADM arrives as a rich message describing it.
  const richTransfer = decryptedMessage.includes('_transaction') ? utils.tryParseJSON(decryptedMessage) : false;
  const isTransfer = decryptedMessage.includes('_transaction') || tx.amount > 0;
  const userComment = richTransfer ? String(richTransfer.comments ?? '') : decryptedMessage;

  let payToUpdate = await paymentsDb.findOne({
    senderId: tx.senderId,
    // Only one payment per user can be awaiting clarification.
    inUpdateState: { $nin: [null, undefined] },
  });

  if (payToUpdate && !utils.isAwaitingClarification(payToUpdate)) {
    payToUpdate = undefined;
  }

  let messageDirective = 'unknown';

  if (payToUpdate) {
    if (isTransfer) {
      // A new transfer arrived while the bot was waiting for an answer about the previous
      // one. Queue the previous payment for refund and work with the new payment.
      await withSenderLock(tx.senderId, async () => {
        const pendingPayments = (
          await paymentsDb.find({
            senderId: tx.senderId,
            inUpdateState: { $nin: [null, undefined] },
            needToSendBack: { $ne: true },
          })
        ).filter((payment) => utils.isAwaitingClarification(payment));

        if (pendingPayments.length) {
          for (const payment of pendingPayments) {
            await payment.update(
              {
                needToSendBack: true,
                isBasicChecksPassed: true,
                inUpdateState: undefined,
              },
              true,
            );
          }

          notify(
            `${config.notifyName} got a payment while it was waiting for the user to clarify ${payToUpdate.inUpdateState} for the exchange of _${payToUpdate.inAmountMessage}_ _${payToUpdate.inCurrency}_. The bot will try to send the previous transfer back and proceed with the new one. ${admTxDescription}.`,
            'warn',
          );

          await messenger.sendMessage(
            tx.senderId,
            `I was waiting for you to clarify ${payToUpdate.inUpdateState}, but got a new payment instead. I’ll proceed with the new transfer and try to send your previous transfer of _${payToUpdate.inAmountMessage}_ _${payToUpdate.inCurrency}_ back to you (if it covers the network fee).`,
          );
        }
      });

      messageDirective = 'exchange';
      payToUpdate = undefined;
    } else if (decryptedMessage.toLowerCase().trim() === '/cancel') {
      messageDirective = 'command';
    } else {
      messageDirective = 'update';
    }
  } else if (isTransfer) {
    messageDirective = 'exchange';
  } else if (decryptedMessage.startsWith('/')) {
    messageDirective = 'command';
  }

  const knownSpammer = await incomingTxsDb.findOne({
    senderId: tx.senderId,
    isSpam: true,
    date: { $gt: utils.unix() - constants.DAY },
  });

  const itx = new incomingTxsDb({
    _id: tx.id,
    txid: tx.id,
    date: utils.unix(),
    timestamp: tx.timestamp,
    amount: tx.amount,
    fee: tx.fee,
    type: tx.type,
    senderId: tx.senderId,
    senderPublicKey: tx.senderPublicKey,
    recipientId: tx.recipientId, // The bot itself
    recipientPublicKey: tx.recipientPublicKey,
    messageDirective, // command, exchange, update or unknown
    decryptedMessage,
    payToUpdateId: payToUpdate ? payToUpdate._id : null,
    spam: false,
    isProcessed: false,
    // Undefined for a transaction delivered over the socket; stored for reference.
    blockId: tx.blockId,
    height: tx.height,
    block_timestamp: tx.block_timestamp,
    confirmations: tx.confirmations,
    // Undefined for a transaction fetched over REST.
    relays: tx.relays,
    receivedAt: tx.receivedAt,
    commandFix,
  });

  // A top-up from the operator is not an exchange request, so it is recorded and left alone.
  //
  // The bot does not validate a top-up, so this shortcut must not be reachable on a
  // claim alone. An ADM transfer proves its own value, because the amount is part of the
  // ADAMANT transaction. A transfer in another blockchain is only announced in a chat
  // message the sender wrote, so it is accepted here only from the operator's own
  // notification address — otherwise anyone could manufacture "top-up received" records.
  const isDeposit =
    userComment.trim().toLowerCase() === 'deposit' &&
    (tx.amount > 0 || (richTransfer && utils.isStringEqual(tx.senderId, config.adamant_notify)));

  if (isDeposit) {
    if (richTransfer) {
      const inCurrency = String(richTransfer.type ?? '')
        .replace(/_transaction$/, '')
        .toUpperCase();

      await depositClaims.markOperatorTopUp(inCurrency, richTransfer.hash, tx.id);
    }

    await itx.update({ isDeposit: true, isProcessed: true }, true);
    await updateProcessedTx(tx, itx, false);

    notify(
      `${config.notifyName} got a top-up transfer from ${tx.senderId}. The bot will not validate it — check it manually. ${admTxDescription}.`,
      'info',
    );
    await messenger.sendMessage(tx.senderId, 'I’ve got a top-up transfer from you. Thanks!');

    return;
  }

  const requestsLastDay = await incomingTxsDb.countDocuments({
    senderId: tx.senderId,
    date: { $gt: utils.unix() - constants.DAY },
  });

  const isSpammer = Boolean(knownSpammer) || requestsLastDay > SPAM_THRESHOLD_PER_DAY;

  if (isSpammer) {
    await itx.update({ isProcessed: true, isSpam: true });
  }

  await itx.save();
  // The checkpoint may move now: the stored record, with isProcessed still false, is
  // what guarantees the transaction is handled. If the handler below fails or the
  // process stops before it finishes, replayUnprocessed() picks the record up again.
  await updateProcessedTx(tx, itx, false);

  // Tell the user once, when the limit is first tripped.
  if (isSpammer && !knownSpammer) {
    notify(
      `${config.notifyName} reports that _${tx.senderId}_ is a spammer or talks too much. ${admTxDescription}.`,
      'warn',
    );
    await messenger.sendMessage(
      tx.senderId,
      'I’ve _banned_ you for today. **Please stop sending messages** — I’ll still process any transfer you’ve already made. Come back tomorrow, and let’s talk less and trade more.',
    );
  }

  // Throttling applies to chatter, never to money. A message that carries value always
  // goes through the pipeline so that a payment record exists for it — without one,
  // nothing validates, pays out or refunds the transfer, and the funds sit in the bot's
  // wallet with only a log line to find them by.
  const isCancelRequest = decryptedMessage.toLowerCase().trim() === '/cancel';
  const carriesValue =
    messageDirective === 'exchange' || messageDirective === 'update' || Boolean(payToUpdate && isCancelRequest);

  if (isSpammer && !carriesValue) {
    return;
  }

  switch (messageDirective) {
    case 'exchange':
      await exchangeTxs(itx, tx);
      break;
    case 'update':
      await exchangeTxs(itx, tx, payToUpdate);
      break;
    case 'command':
      await commandTxs(decryptedMessage, tx, itx);
      break;
    default:
      await unknownTxs(tx, itx);
      break;
  }

  await itx.update({ isProcessed: true }, true);
}

/**
 * Finishes stored incoming records whose handler never completed.
 *
 * A record is stored before its handler runs, so a crash, a failed database write or
 * an exception in the handler leaves it with `isProcessed: false`. Only transfers
 * and pending cancellation requests are replayed — a missed reply to small talk or a
 * read-only command is not worth a duplicate — and each replay first checks whether the
 * handler had in fact already done its work, so a replay never creates a second payment.
 *
 * @returns {Promise<void>}
 */
async function replayUnprocessed() {
  const records = await db.incomingTxsDb.find({
    isProcessed: false,
    isSpam: { $ne: true },
    isDeposit: { $ne: true },
    date: { $lt: utils.unix() - REPLAY_DELAY },
  });

  for (const itx of records) {
    if (inFlightTxs.has(itx.txid)) {
      continue;
    }

    inFlightTxs.add(itx.txid);

    try {
      await replayRecord(itx);
    } catch (error) {
      log.error(`Unable to finish the stored incoming Tx ${itx.txid}. Will try again later. ${error}`);
    } finally {
      inFlightTxs.delete(itx.txid);
    }
  }
}

/**
 * Finishes one stored incoming record, or hands it to the operator after too many attempts.
 *
 * @param {object} itx Stored incoming-transaction document
 * @returns {Promise<void>}
 */
async function replayRecord(itx) {
  const attempts = (itx.replayAttempts ?? 0) + 1;

  if (attempts > MAX_REPLAY_ATTEMPTS) {
    await itx.update({ isProcessed: true, processingFailed: true }, true);

    notify(
      `${config.notifyName} could not process the incoming Tx _${itx.txid}_ from _${itx.senderId}_ after ${MAX_REPLAY_ATTEMPTS} attempts. **Attention needed** — check it manually. Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${itx.txid}.`,
      'error',
    );

    return;
  }

  await itx.update({ replayAttempts: attempts }, true);

  const isTransfer = itx.messageDirective === 'exchange' || itx.messageDirective === 'update';
  const isCancel =
    itx.messageDirective === 'command' &&
    itx.decryptedMessage?.toLowerCase().trim() === '/cancel' &&
    Boolean(itx.payToUpdateId);

  if (!isTransfer && !isCancel) {
    await itx.update({ isProcessed: true }, true);

    return;
  }

  // The handler may have created the payment before the process stopped.
  if (itx.messageDirective === 'exchange' && (await db.paymentsDb.findOne({ _id: itx.txid }))) {
    await itx.update({ isProcessed: true }, true);

    return;
  }

  let payToUpdate;

  if (itx.messageDirective === 'update') {
    payToUpdate = await db.paymentsDb.findOne({ _id: itx.payToUpdateId });

    // The clarification was applied, or the request was dropped since.
    if (!payToUpdate || !utils.isAwaitingClarification(payToUpdate)) {
      await itx.update({ isProcessed: true }, true);

      return;
    }
  }

  if (isCancel) {
    const payToCancel = await db.paymentsDb.findOne({ _id: itx.payToUpdateId });

    // The cancellation was applied, or the request was finished/refunded since.
    if (!payToCancel || !utils.isAwaitingClarification(payToCancel) || payToCancel.needToSendBack) {
      await itx.update({ isProcessed: true }, true);

      return;
    }
  }

  // The stored copy of the message is not proof of anything; the transaction is read
  // from the blockchain again.
  const response = await api.getTransaction(itx.txid, { returnAsset: 1 });

  if (!response.success || !response.transaction) {
    log.warn(
      `Unable to fetch the ADM Tx ${itx.txid} to finish its stored record. ${response.errorMessage}. Will try again later.`,
    );

    return;
  }

  const tx = response.transaction;

  if (tx.recipientId !== config.address || tx.senderId !== itx.senderId) {
    await itx.update({ isProcessed: true, processingFailed: true }, true);
    log.error(`The ADM Tx ${itx.txid} no longer matches its stored record. Marked as failed.`);

    return;
  }

  log.log(`Finishing the stored incoming Tx ${itx.txid} (attempt ${attempts})…`);

  if (isCancel) {
    await commandTxs(itx.decryptedMessage, tx, itx);
  } else {
    await exchangeTxs(itx, tx, payToUpdate);
  }

  await itx.update({ isProcessed: true }, true);
}

module.exports.replayUnprocessed = replayUnprocessed;
