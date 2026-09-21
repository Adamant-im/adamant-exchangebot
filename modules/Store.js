const db = require('./DB');
const log = require('../helpers/log');
const utils = require('../helpers/utils');

module.exports = {
  /**
   * Height of the last ADM block whose transactions the bot has processed.
   *
   * Kept in memory and mirrored in the `systems` collection so a restart resumes
   * where the previous run stopped instead of re-processing or skipping messages.
   *
   * @type {number|undefined}
   */
  lastProcessedBlockHeight: undefined,

  /**
   * Returns the last processed block height, restoring it from the database or,
   * on a first run, initialising it to the current blockchain height.
   *
   * @returns {Promise<number|undefined>} The height, or `undefined` when it could not be determined
   */
  async getLastProcessedBlockHeight() {
    // Required lazily: the coin registry needs the config and the API client,
    // which in turn makes a top-level require here a circular dependency.
    const exchangerUtils = require('../helpers/cryptos/exchanger');

    if (this.lastProcessedBlockHeight) {
      return this.lastProcessedBlockHeight;
    }

    const systemData = await db.systemDb.findOne();

    if (systemData?.lastProcessedBlockHeight) {
      this.lastProcessedBlockHeight = systemData.lastProcessedBlockHeight;

      return this.lastProcessedBlockHeight;
    }

    const lastBlockHeight = await exchangerUtils.ADM.getLastBlockHeight();

    if (lastBlockHeight) {
      await this.updateSystemDbField('lastProcessedBlockHeight', lastBlockHeight);

      return this.lastProcessedBlockHeight;
    }

    log.warn(
      `Unable to store the last ADM block in getLastProcessedBlockHeight() of ${utils.getModuleName(module.id)} module. Will try next time.`,
    );

    return undefined;
  },

  /**
   * Writes a single field of the bot's system document.
   *
   * @param {string} field Field name
   * @param {*} data Value to store
   * @returns {Promise<void>}
   */
  async updateSystemDbField(field, data) {
    await db.systemDb.db.updateOne({}, { $set: { [field]: data } }, { upsert: true });

    this[field] = data;
  },

  /**
   * Advances the last processed block height.
   *
   * The height only ever moves forward: transactions arrive both over the socket
   * and through REST polling, so out-of-order updates are normal and must not
   * rewind the marker.
   *
   * @param {number} [height] Height of the block a processed transaction belongs to
   * @returns {Promise<void>}
   */
  async updateLastProcessedBlockHeight(height) {
    if (!height) {
      return;
    }

    if (!this.lastProcessedBlockHeight || height > this.lastProcessedBlockHeight) {
      await this.updateSystemDbField('lastProcessedBlockHeight', height);
    }
  },
};
