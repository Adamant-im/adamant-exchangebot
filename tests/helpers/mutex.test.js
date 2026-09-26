const { createKeyedMutex } = require('../../helpers/mutex');

/**
 * Returns a promise with its resolver exposed, to control when an operation finishes.
 *
 * @returns {{promise: Promise<void>, resolve: () => void}}
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe('createKeyedMutex', () => {
  test('runs operations with the same key one at a time, in order', async () => {
    const withLock = createKeyedMutex();
    const events = [];
    const first = deferred();

    const a = withLock('wallet', async () => {
      events.push('a:start');
      await first.promise;
      events.push('a:end');
    });
    const b = withLock('wallet', async () => {
      events.push('b:start');
    });

    await Promise.resolve();
    expect(events).toEqual(['a:start']);

    first.resolve();
    await Promise.all([a, b]);

    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
  });

  test('lets operations with different keys run at the same time', async () => {
    const withLock = createKeyedMutex();
    const events = [];
    const first = deferred();

    const a = withLock('btc', async () => {
      events.push('btc:start');
      await first.promise;
    });
    const b = withLock('dash', async () => {
      events.push('dash:start');
    });

    await b;
    expect(events).toEqual(['btc:start', 'dash:start']);

    first.resolve();
    await a;
  });

  test('releases the lock when an operation throws', async () => {
    const withLock = createKeyedMutex();

    await expect(
      withLock('wallet', async () => {
        throw new Error('broadcast failed');
      }),
    ).rejects.toThrow('broadcast failed');

    await expect(withLock('wallet', async () => 'next')).resolves.toBe('next');
  });

  test('returns the operation’s result', async () => {
    const withLock = createKeyedMutex();

    await expect(withLock('wallet', async () => ({ success: true }))).resolves.toEqual({ success: true });
  });
});
