const axios = require('axios');

const log = require('../log');

/** How long to wait for a coin node before trying the next one. */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Formats an Axios failure into a single readable line.
 *
 * @param {Error} error Error thrown by Axios
 * @returns {string}
 */
function formatError(error) {
  const response = error.response;
  const status = response ? ` (HTTP ${response.status})` : '';
  const payload = response?.data;

  let details = '';

  if (payload && typeof payload === 'object') {
    const reason = payload.error ?? payload.message ?? payload.errorMessage;

    if (reason !== undefined && reason !== null) {
      details = `. Node's reply: ${typeof reason === 'object' ? JSON.stringify(reason) : String(reason).trim()}`;
    }
  } else if (typeof payload === 'string' && payload.trim()) {
    details = `. Node's reply: ${payload.trim()}`;
  }

  return `${error.message}${status}${details}`;
}

/**
 * HTTP client for a coin's nodes, with failover across the configured list.
 *
 * The config declares several nodes per coin, but a single unreachable node used
 * to take that coin down completely. This client remembers which node last worked
 * and moves on to the next one whenever a request fails, so one dead node only
 * costs a retry.
 */
class NodeClient {
  /**
   * @param {string} coin Ticker, used in log messages
   * @param {string[]} nodes Node base URLs, in preference order
   */
  constructor(coin, nodes) {
    if (!Array.isArray(nodes) || !nodes.length) {
      throw new Error(`No nodes configured for ${coin}.`);
    }

    this.coin = coin;
    this.nodes = nodes.map((node) => node.replace(/\/+$/, ''));
    this.currentNodeIndex = 0;
  }

  /**
   * The node the client is currently using.
   *
   * @returns {string}
   */
  get node() {
    return this.nodes[this.currentNodeIndex];
  }

  /**
   * Sends a request, trying every configured node until one answers.
   *
   * @param {object} options Request options
   * @param {string} [options.endpoint] Path appended to the node URL
   * @param {'get'|'post'} [options.method] HTTP method
   * @param {*} [options.data] Request body, for POST requests
   * @param {string} [options.description] What the request is for, used in log messages
   * @param {boolean} [options.quiet] Do not log a failure; the caller reports it
   * @returns {Promise<*>} The response body, or `undefined` when every node failed
   */
  async request({ endpoint = '', method = 'get', data, description, quiet = false }) {
    const what = description || endpoint || method;
    const errors = [];
    // Walk the list from the node that last worked, using a local cursor. Several
    // requests run at once — balances, heights, fees — and a shared cursor advanced
    // by each failure would make concurrent requests retry the same dead node.
    const startIndex = this.currentNodeIndex;

    for (let attempt = 0; attempt < this.nodes.length; attempt += 1) {
      const index = (startIndex + attempt) % this.nodes.length;
      const node = this.nodes[index];

      try {
        const response = await axios({
          url: `${node}${endpoint}`,
          method,
          data,
          timeout: REQUEST_TIMEOUT_MS,
        });

        this.currentNodeIndex = index;

        return response.data;
      } catch (error) {
        errors.push(`${node}: ${formatError(error)}`);
      }
    }

    if (!quiet) {
      log.warn(`Request '${what}' to every ${this.coin} node failed. ${errors.join('; ')}.`);
    }

    return undefined;
  }

  /**
   * Sends a JSON-RPC call, trying every configured node until one answers.
   *
   * @param {string} method RPC method name
   * @param {Array} [params] RPC parameters
   * @param {object} [options] Request options
   * @param {boolean} [options.quiet] Do not log an RPC-level error; the caller reports it
   * @returns {Promise<*>} The RPC result, or `undefined` on failure
   */
  async rpc(method, params = [], { quiet = false } = {}) {
    const body = await this.request({
      method: 'post',
      data: { method, params },
      description: method,
      quiet,
    });

    if (!body) {
      return undefined;
    }

    if (body.error) {
      if (!quiet) {
        const reason = typeof body.error === 'object' ? JSON.stringify(body.error) : String(body.error);

        log.warn(`${this.coin} node returned an error for '${method}'. ${reason}.`);
      }

      return undefined;
    }

    return body.result;
  }
}

module.exports = { NodeClient, formatError };
