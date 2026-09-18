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
const Store = require('./Store');

/** Messages from one user per 24 hours above which the user is treated as a spammer. */
const SPAM_THRESHOLD_PER_DAY = 65;

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
    const document = itx ?? (await db.incomingTxsDb.findOne({ txid: tx.id }));

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

  const cached = processedTxs.get(tx.id);

  if (cached) {
    if (!cached.height) {
      await updateProcessedTx(tx, null, true);
    }

    return;
  }

  const { incomingTxsDb, paymentsDb } = db;
  const knownTx = await incomingTxsDb.findOne({ txid: tx.id });

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

  // Users often type a command without the leading slash; accept the two most common ones.
  if (decryptedMessage.toLowerCase() === 'help') {
    decryptedMessage = '/help';
    commandFix = 'help';
  }

  if (decryptedMessage.toLowerCase() === '/balance') {
    decryptedMessage = '/balances';
    commandFix = 'balance';
  }

  // A transfer of a coin other than ADM arrives as a rich message describing it.
  const richTransfer = decryptedMessage.includes('_transaction') ? utils.tryParseJSON(decryptedMessage) : false;
  const isTransfer = decryptedMessage.includes('_transaction') || tx.amount > 0;
  const userComment = richTransfer ? String(richTransfer.comments ?? '') : decryptedMessage;

  let payToUpdate = await paymentsDb.findOne({
    senderId: tx.senderId,
    // Only one payment per user can be awaiting clarification.
    inUpdateState: { $ne: undefined },
  });

  let messageDirective = 'unknown';

  if (payToUpdate) {
    if (isTransfer) {
      // A new transfer arrived while the bot was waiting for an answer about the previous
      // one. Drop the old request — it may have failed — and work with the new payment.
      const pendingPayments = await paymentsDb.find({
        senderId: tx.senderId,
        inUpdateState: { $ne: undefined },
      });

      for (const payment of pendingPayments) {
        await payment.update({ isIgnored: true, isProcessed: true, inUpdateState: undefined }, true);
      }

      notify(
        `${config.notifyName} got a payment while it was waiting for the user to clarify ${payToUpdate.inUpdateState} for the exchange of _${payToUpdate.inAmountMessage}_ _${payToUpdate.inCurrency}_. The bot will forget the previous payment in favour of the new one. The user may contact you. ${admTxDescription}.`,
        'warn',
      );

      await messenger.sendMessage(
        tx.senderId,
        `I was waiting for you to clarify ${payToUpdate.inUpdateState}, but got a payment instead. I’ll forget the previous transfer of _${payToUpdate.inAmountMessage}_ _${payToUpdate.inCurrency}_ in favour of the new one. If that’s not what you meant, contact my master.`,
      );

      messageDirective = 'exchange';
      payToUpdate = undefined;
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
  const carriesValue = messageDirective === 'exchange' || messageDirective === 'update';

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
};
