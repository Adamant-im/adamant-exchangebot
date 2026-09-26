const { MessageType } = require('adamant-api');

const api = require('../modules/api');
const config = require('../modules/configReader');
const log = require('./log');

module.exports = {
  /**
   * Sends an encrypted in-chat message to a user.
   *
   * Every pipeline module replies to users, and none of them should fail an
   * exchange because a reply could not be delivered — the failure is logged and
   * reported through the return value instead.
   *
   * @param {string} addressOrPublicKey Recipient's ADM address or public key
   * @param {string} message Message text, in Markdown
   * @param {number} [type=MessageType.Chat] ADAMANT message type; use `MessageType.Rich` for a transfer card
   * @returns {Promise<boolean>} Whether the message was accepted by the network
   */
  async sendMessage(addressOrPublicKey, message, type = MessageType.Chat) {
    if (!message) {
      return false;
    }

    try {
      const response = await api.sendMessage(config.passPhrase, addressOrPublicKey, message, type);

      if (!response.success) {
        log.warn(`Failed to send an ADM message to ${addressOrPublicKey}. ${response.errorMessage}.`);

        return false;
      }

      return true;
    } catch (error) {
      log.warn(`Failed to send an ADM message to ${addressOrPublicKey}. ${error}.`);

      return false;
    }
  },

  /**
   * Sends a rich message describing a transfer the bot made in another blockchain.
   *
   * ADAMANT Messenger renders this as a transfer card with a link to the block
   * explorer, which is how the user sees an exchange payout that did not happen on
   * the ADAMANT chain.
   *
   * @param {string} addressOrPublicKey Recipient's ADM address or public key
   * @param {string} coin Ticker of the coin that was sent
   * @param {number|string} amount Amount that was sent
   * @param {string} hash Transaction hash
   * @param {string} comment Message shown with the transfer
   * @returns {Promise<boolean>} Whether the message was accepted by the network
   */
  async sendTransferMessage(addressOrPublicKey, coin, amount, hash, comment) {
    const payload = JSON.stringify({
      type: `${coin.toLowerCase()}_transaction`,
      amount: String(amount),
      hash,
      comments: comment,
    });

    return this.sendMessage(addressOrPublicKey, payload, MessageType.Rich);
  },
};
