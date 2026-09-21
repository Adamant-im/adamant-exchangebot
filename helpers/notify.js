const axios = require('axios');
const { isAdmAddress, MessageType } = require('adamant-api');

const config = require('../modules/configReader');
const log = require('./log');
const api = require('../modules/api');

/** Slack attachment colours, one per message type. */
const SLACK_COLORS = {
  error: '#FF0000',
  warn: '#FFFF00',
  info: '#00FF00',
  log: '#FFFFFF',
};

const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/services/';

/**
 * Whether the configured Slack webhook looks usable.
 *
 * The shipped config carries the bare prefix as a placeholder, so the length check
 * keeps the bot from posting to an obviously incomplete URL. Restricting the host
 * also means a mistyped config cannot turn notifications into a request to an
 * arbitrary server.
 *
 * @type {boolean}
 */
const isSlackConfigured =
  typeof config.slack === 'string' &&
  config.slack.startsWith(SLACK_WEBHOOK_PREFIX) &&
  config.slack.length > SLACK_WEBHOOK_PREFIX.length;

/**
 * Whether the configured ADAMANT notification address is a valid ADM address.
 *
 * @type {boolean}
 */
const isAdamantNotifyConfigured = isAdmAddress(config.adamant_notify);

if (config.adamant_notify && !isAdamantNotifyConfigured) {
  log.warn(`'adamant_notify' is set to '${config.adamant_notify}', which is not an ADM address. Ignoring it.`);
}

/**
 * Strips Markdown emphasis so a message reads well in plain log output.
 *
 * @param {string} text Message text
 * @returns {string}
 */
function removeMarkdown(text) {
  return doubleAsterisksToSingle(text)
    .replace(/(^|[\s([{])([*_]{1,2})(?=\S)/g, '$1')
    .replace(/(?<=\S)([*_]{1,2})(?=$|[\s)\]}.,!?:;])/g, '');
}

/**
 * Converts `**bold**` to Slack's single-asterisk `*bold*`.
 *
 * @param {string} text Message text
 * @returns {string}
 */
function doubleAsterisksToSingle(text) {
  return text.replace(/(\*\*\b|\b\*\*)/g, '*');
}

/**
 * Converts `*bold*` to Markdown's `**bold**`.
 *
 * @param {string} text Message text
 * @returns {string}
 */
function singleAsteriskToDouble(text) {
  return text.replace(/(\*\b|\b\*)/g, '**');
}

/**
 * Normalizes emphasis for ADAMANT Messenger, which renders Markdown.
 *
 * @param {string} text Message text
 * @returns {string}
 */
function makeBoldForMarkdown(text) {
  return singleAsteriskToDouble(doubleAsterisksToSingle(text));
}

/**
 * Posts a notification to the configured Slack webhook.
 *
 * @param {string} message Message text
 * @param {'error'|'warn'|'info'|'log'} type Message type
 * @returns {Promise<void>}
 */
async function notifySlack(message, type) {
  const params = {
    attachments: [
      {
        fallback: message,
        color: SLACK_COLORS[type],
        text: doubleAsterisksToSingle(message),
        mrkdwn_in: ['text'],
      },
    ],
  };

  try {
    await axios.post(config.slack, params);
  } catch (error) {
    log.warn(`Failed to send a Slack notification. ${error}.`);
  }
}

/**
 * Sends a notification to the operator's ADAMANT address.
 *
 * @param {string} message Message text
 * @param {'error'|'warn'|'info'|'log'} type Message type
 * @returns {Promise<void>}
 */
async function notifyAdamant(message, type) {
  const text = `${type}| ${makeBoldForMarkdown(message)}`;

  try {
    const response = await api.sendMessage(config.passPhrase, config.adamant_notify, text, MessageType.Chat);

    if (!response.success) {
      log.warn(`Failed to send a notification to ${config.adamant_notify}. ${response.errorMessage}.`);
    }
  } catch (error) {
    log.warn(`Failed to send a notification to ${config.adamant_notify}. ${error}.`);
  }
}

/**
 * Logs a message and, unless muted, forwards it to the operator over Slack and
 * ADAMANT Messenger.
 *
 * Notifications are fire-and-forget on purpose: an unreachable Slack or ADM node
 * must never block or fail an exchange.
 *
 * @param {string} message Message text, in Markdown
 * @param {'error'|'warn'|'info'|'log'} type Message type
 * @param {boolean} [silentMode] Only write to the log, do not notify anyone
 */
module.exports = (message, type, silentMode = false) => {
  try {
    log[type](removeMarkdown(message));

    if (silentMode) {
      return;
    }

    if (isSlackConfigured) {
      void notifySlack(message, type);
    }

    if (isAdamantNotifyConfigured) {
      void notifyAdamant(message, type);
    }
  } catch (error) {
    log.error(`Notifier error: ${error}`);
  }
};
