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

/**
 * Reads KVS records with plain query parameters.
 *
 * `adamant-api` v3 prefixes every filter with `and:`, which released ADAMANT nodes
 * drop on `/api/states/get` (Adamant-im/adamant#277, adamant-api-jsclient#97). A
 * filtered query then returns every KVS record in the network, and the first one is
 * the latest write by any account under any key. Until the SDK fix ships, the bot
 * queries with plain parameters, which the nodes honour, and still validates every
 * record it gets back.
 *
 * The method is attached to the client instance rather than exported next to a copy
 * of it: spreading an `AdamantApi` instance copies its fields but none of its
 * prototype methods, which would leave `onReady`, `sendMessage` and the rest undefined.
 *
 * @param {object} params Query parameters, for example `{ senderId, key }`
 * @returns {Promise<object>} The node response
 */
api.getKvsRecords = function getKvsRecords(params) {
  return api.get('states/get', params);
};

module.exports = api;
