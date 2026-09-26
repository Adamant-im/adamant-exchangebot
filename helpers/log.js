const fs = require('fs');
const path = require('path');

const config = require('../modules/configReader');
const utils = require('./utils');

const LOG_DIR = path.resolve(__dirname, '..', 'logs');

/** Verbosity thresholds, from quietest to most verbose. */
const LEVELS = ['none', 'error', 'warn', 'info', 'log', 'debug', 'trace'];

/** ANSI colours used for console output, one per level. */
const COLORS = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[32m',
  log: '\x1b[34m',
  debug: '\x1b[36m',
  trace: '\x1b[90m',
};
const COLOR_RESET = '\x1b[0m';

/**
 * Jest workers must not litter the repository with log files, and a test run
 * should never depend on the filesystem being writable.
 */
const isTestRun = Boolean(process.env.JEST_WORKER_ID);

let stream;
let streamDate;

/**
 * Returns the current date as `YYYY-MM-DD`, used for the log file name.
 *
 * @returns {string}
 */
function currentDate() {
  return utils.formatDate(Date.now()).YYYY_MM_DD;
}

/**
 * Returns `YYYY-MM-DD HH:mm:ss` for log line prefixes.
 *
 * @returns {string}
 */
function fullTime() {
  const formatted = utils.formatDate(Date.now());

  return `${formatted.YYYY_MM_DD} ${formatted.hh_mm_ss}`;
}

/**
 * Opens the log file for the current day, creating `logs/` on first use.
 *
 * The stream is created lazily, and rotated when the date changes, so a
 * long-running bot writes one file per day and requiring this module has
 * no side effects.
 *
 * @returns {import('fs').WriteStream|undefined} The stream, or `undefined` when file logging is off
 */
function getStream() {
  if (isTestRun) {
    return undefined;
  }

  const date = currentDate();

  if (stream && streamDate === date) {
    return stream;
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });

    stream?.end();
    stream = fs.createWriteStream(path.join(LOG_DIR, `${date}.log`), { flags: 'a' });
    streamDate = date;
    stream.write(`\n\n[The bot started] _________________${fullTime()}_________________\n`);

    return stream;
  } catch (error) {
    // Losing the log file must not take the bot down; the console output stays.
    console.error(`Unable to open the log file in ${LOG_DIR}. ${error}`);
    return undefined;
  }
}

/**
 * Removes the bot's passphrase from a message.
 *
 * Nothing should ever pass a passphrase to the logger, but an unexpected error
 * object or a config dump could carry one, and a leaked passphrase is a loss of
 * every hot wallet the bot controls.
 *
 * @param {string} message Message to sanitize
 * @returns {string}
 */
function redactSecrets(message) {
  if (!config.passPhrase) {
    return message;
  }

  return message.split(config.passPhrase).join('<passphrase hidden>');
}

/**
 * Writes a message at the given level, if the configured verbosity allows it.
 *
 * @param {'error'|'warn'|'info'|'log'|'debug'|'trace'} level Message level
 * @param {*} message Message to write
 */
function write(level, message) {
  const threshold = LEVELS.indexOf(config.log_level);

  if (threshold < LEVELS.indexOf(level)) {
    return;
  }

  const text = redactSecrets(String(message));
  const prefix = `${level}|${fullTime()}`;

  console.log(COLORS[level], prefix, COLOR_RESET, text);
  getStream()?.write(`\n ${prefix}|${text}`);
}

module.exports = {
  /**
   * Logs a failure that needs attention.
   *
   * @param {*} message Message to log
   */
  error(message) {
    write('error', message);
  },

  /**
   * Logs a recoverable problem, such as a request that will be retried.
   *
   * @param {*} message Message to log
   */
  warn(message) {
    write('warn', message);
  },

  /**
   * Logs an event an operator would want to see, such as a completed exchange.
   *
   * @param {*} message Message to log
   */
  info(message) {
    write('info', message);
  },

  /**
   * Logs routine progress details.
   *
   * @param {*} message Message to log
   */
  log(message) {
    write('log', message);
  },

  /**
   * Logs verbose diagnostics intended for debugging integrations.
   *
   * @param {*} message Message to log
   */
  debug(message) {
    write('debug', message);
  },

  /**
   * Logs the most detailed execution trace.
   *
   * @param {*} message Message to log
   */
  trace(message) {
    write('trace', message);
  },
};
