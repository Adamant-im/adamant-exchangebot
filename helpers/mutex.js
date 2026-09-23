/**
 * Creates a keyed mutex: operations that share a key run one at a time, in the order
 * they asked for the lock; operations with different keys run concurrently.
 *
 * The bot is a single process, so an in-memory lock is enough to make a
 * read-check-write sequence atomic against every other worker in it — for example,
 * two sends that would otherwise pick the same nonce or the same UTXO.
 *
 * @returns {(key: unknown, operation: () => Promise<T>) => Promise<T>} A function that
 *   runs `operation` while holding the lock for `key`
 * @template T
 */
function createKeyedMutex() {
  /** Tail of the queue for each key: the promise the next caller must wait for. */
  const tails = new Map();

  return async function withLock(key, operation) {
    const previous = tails.get(key) ?? Promise.resolve();
    let release;

    const current = new Promise((resolve) => {
      release = resolve;
    });

    tails.set(key, current);

    await previous;

    try {
      return await operation();
    } finally {
      release();

      // Only the last caller in the queue may remove the entry; an earlier one would
      // otherwise let a later caller skip the queue.
      if (tails.get(key) === current) {
        tails.delete(key);
      }
    }
  };
}

/**
 * Keyed mutex that serializes exchange requests, clarifications, and cancellations per sender.
 */
const withSenderLock = createKeyedMutex();

module.exports = { createKeyedMutex, withSenderLock };
