/**
 * Shared behaviour of every coin adapter.
 *
 * A coin adapter is the bot's only interface to a blockchain. The pipeline modules
 * work against this surface and never talk to a node directly, which is what keeps
 * adding — or later replacing — a coin a local change.
 *
 * @abstract
 */
module.exports = class BaseCoin {
  /**
   * Per-instance cache of values that are expensive to fetch, such as balances,
   * fee estimates and the last block.
   *
   * Each entry is registered by the adapter with a `lifetime`, in milliseconds.
   */
  cache = {
    /**
     * Returns a cached value.
     *
     * @param {string} name Entry name, as registered by the adapter
     * @param {boolean} [validOnly] Return the value only while it is fresh
     * @returns {*} The cached value, or `undefined` when it is absent or stale
     */
    getData(name, validOnly) {
      const entry = this[name];

      if (entry?.timestamp) {
        if (!validOnly || Date.now() - entry.timestamp < entry.lifetime) {
          return entry.value;
        }
      }

      return undefined;
    },

    /**
     * Stores a value and stamps it with the current time.
     *
     * @param {string} name Entry name, as registered by the adapter
     * @param {*} value Value to cache
     */
    cacheData(name, value) {
      this[name].value = value;
      this[name].timestamp = Date.now();
    },
  };

  /** Wallet the adapter signs with, derived from the bot's ADAMANT passphrase. */
  account = {
    passPhrase: undefined,
    privateKey: undefined,
    keyPair: undefined,
    address: undefined,
  };

  /**
   * Sends a transfer.
   *
   * The result distinguishes three outcomes, and the payment workers depend on it:
   *
   * - `{success: true, hash}` — broadcast, and the hash is known
   * - `{success: false, error}` — refused before anything reached the network, so the
   *   caller may safely try again
   * - `{success: false, isAmbiguous: true, error}` — the transfer may or may not have
   *   been broadcast. The caller must never retry it; it goes to a human instead.
   *
   * @abstract
   * @param {object} _params Transfer parameters
   * @returns {Promise<{success: boolean, hash?: string, error?: string, isAmbiguous?: boolean}>}
   */
  async send(_params) {
    return { success: false, error: 'send() is not implemented' };
  }

  /**
   * Checks that an address belongs to this coin's network.
   *
   * Called before every payout: an address that reaches the bot through an ADAMANT
   * KVS record is user-supplied data, and a transfer to a malformed address is
   * unrecoverable.
   *
   * @abstract
   * @param {string} _address Address to validate
   * @returns {boolean}
   */
  isValidAddress(_address) {
    return false;
  }
};
