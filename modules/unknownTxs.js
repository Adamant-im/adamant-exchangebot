const db = require('./DB');
const config = require('./configReader');
const constants = require('../helpers/const');
const log = require('../helpers/log');
const utils = require('../helpers/utils');
const messenger = require('../helpers/messenger');
const { PHRASE_COLLECTIONS } = require('../helpers/phrases');

/**
 * A conversation is treated as new when the previous unparsable message is older
 * than this, so a user who comes back a day later is greeted rather than scolded.
 */
const CONVERSATION_GAP = 2 * 60 * 60 * 1000;

/** How many messages the user must have sent to reach each phrase collection. */
const ESCALATION_THRESHOLDS = [10, 20, 30, 40, 50];

/**
 * Picks the reply for a user who has sent `messageCount` unparsable messages.
 *
 * @param {number} messageCount Number of unparsable messages in the last 24 hours
 * @returns {string} The reply text
 */
function chooseReply(messageCount) {
  if (messageCount === 1) {
    return `${config.welcome_string} Every command starts with a slash **/**.`;
  }

  if (messageCount === 2) {
    return 'It seems we don’t share a language. Contact my master and ask them to teach me 🎓 yours — it may take a while, I’m no genius 🤓.';
  }

  if (messageCount === 3) {
    return 'Hmm. Contact my master, not me. No, I don’t know how to reach them — ADAMANT is quite anonymous 🤪. Note: every command starts with a slash **/**. Try **/help**.';
  }

  if (messageCount === 4) {
    return 'I see. You just want to talk 🗣️. Talking is not my strong suit.';
  }

  const collectionIndex = ESCALATION_THRESHOLDS.filter((threshold) => messageCount >= threshold).length;
  const phrases = PHRASE_COLLECTIONS[collectionIndex];

  return phrases[utils.getRandomIntInclusive(0, phrases.length - 1)];
}

/**
 * Replies to a message the bot could not interpret as a command or an exchange request.
 *
 * @param {object} tx ADAMANT transaction
 * @param {object} itx Stored incoming transaction
 * @returns {Promise<void>}
 */
module.exports = async (tx, itx) => {
  try {
    const previousMessages = await db.incomingTxsDb.find(
      {
        senderId: tx.senderId,
        messageDirective: 'unknown',
        date: { $gt: utils.unix() - constants.DAY },
      },
      { sort: { date: -1 } },
    );

    // `previousMessages[0]` is the message being handled right now, so `[1]` is the
    // one before it. A long gap means this is a fresh conversation.
    const previous = previousMessages[1];
    const messageCount = !previous || previous.date < utils.unix() - CONVERSATION_GAP ? 1 : previousMessages.length;

    await messenger.sendMessage(tx.senderId, chooseReply(messageCount));
    await itx.update({ isProcessed: true }, true);
  } catch (error) {
    log.error(`Error while replying to an unknown message from ${tx?.senderId} (transaction ${tx?.id}). ${error}`);
  }
};

module.exports.chooseReply = chooseReply;
