const { AdamantApi, WebSocketClient } = require('adamant-api');

const config = require('./configReader');
const log = require('../helpers/log');

/**
 * Socket subscription to the bot's own ADAMANT address.
 *
 * It is created before the API client and handed to it, because the node health
 * check is what points the socket at a live node — a socket attached afterwards
 * would sit idle until the next health check.
 *
 * @type {import('adamant-api').WebSocketClient|undefined}
 */
const socket = config.socket
  ? new WebSocketClient({
      admAddress: config.address,
      wsType: config.ws_type,
      logger: log,
    })
  : undefined;

/**
 * Shared ADAMANT Node client.
 *
 * `AdamantApi` health-checks the configured nodes, keeps using a node that is live
 * and at an actual blockchain height, and fails over for safe GET requests. POST
 * requests are never replayed after an explicit rejection, so a transfer cannot be
 * broadcast twice by a retry.
 *
 * @type {import('adamant-api').AdamantApi}
 */
const api = new AdamantApi({
  nodes: config.node_ADM,
  logLevel: config.log_level,
  logger: log,
  socket,
});

module.exports = api;
