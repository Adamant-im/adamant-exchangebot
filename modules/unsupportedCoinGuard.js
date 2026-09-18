const config = require('./configReader');
const constants = require('../helpers/const');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const exchangerUtils = require('../helpers/cryptos/exchanger');

/**
 * Stops automatic processing of a payment that references a coin adapter the bot no longer has.
 *
 * This is primarily for legacy records left in MongoDB after an operator removes
 * support for a coin. Retrying them forever is both noisy and unsafe.
 *
 * @param {object} pay Payment document
 * @param {object} options Guard options
 * @param {string} options.coin Ticker referenced by the payment
 * @param {string} options.stage Human-readable processing stage
 * @param {string} options.admTxDescription Link to the originating ADAMANT transaction
 * @param {string} [options.errorField='error'] Payment field that stores the error code
 * @param {object} [options.extraUpdates] Extra fields to persist together with the quarantine flag
 * @returns {Promise<boolean>} `true` when the adapter exists, `false` when the payment was quarantined
 */
async function ensureSupportedCoin(pay, { coin, stage, admTxDescription, errorField = 'error', extraUpdates = {} }) {
  if (coin && exchangerUtils[coin]) {
    return true;
  }

  const updates = {
    needHumanCheck: true,
    isFinished: true,
    ...extraUpdates,
  };

  if (errorField) {
    updates[errorField] = constants.ERRORS.UNSUPPORTED_COIN;
  }

  await pay.update(updates, true);

  log.error(
    `Unsupported legacy coin '${coin}' while ${stage} for payment ${pay._id}. Automatic processing stopped. ${admTxDescription}.`,
  );
  notify(
    `${config.notifyName} stopped ${stage} for payment _${pay._id}_ because the stored coin _${coin}_ is no longer supported by this bot. **Attention needed**. Automatic retries were disabled. ${admTxDescription}.`,
    'error',
  );

  return false;
}

module.exports = { ensureSupportedCoin };
