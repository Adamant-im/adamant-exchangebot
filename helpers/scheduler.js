const log = require('./log');

/**
 * Runs a task on a timer, never letting two runs overlap.
 *
 * Every worker in the payment pipeline queries the database, talks to a node and
 * then writes back. If a slow run overlapped with the next tick, the two would read
 * the same pending payment and could send it twice, so a tick that arrives while the
 * previous run is still working is skipped rather than queued.
 *
 * @param {string} name Worker name, used in log messages
 * @param {() => Promise<void>} task Work to run on each tick
 * @param {number} intervalMs Delay between ticks, in milliseconds
 * @returns {NodeJS.Timeout} The interval handle, so tests and shutdown code can clear it
 */
function startInterval(name, task, intervalMs) {
  let isRunning = false;

  return setInterval(async () => {
    if (isRunning) {
      log.log(`Postponing the ${name} iteration for ${intervalMs} ms: the previous one is still in progress.`);

      return;
    }

    isRunning = true;

    try {
      await task();
    } catch (error) {
      log.error(`Error in the ${name} iteration: ${error}`);
    } finally {
      isRunning = false;
    }
  }, intervalMs);
}

module.exports = { startInterval };
