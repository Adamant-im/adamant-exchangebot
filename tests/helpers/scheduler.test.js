jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const log = require('../../helpers/log');
const { startInterval } = require('../../helpers/scheduler');

describe('scheduler.startInterval', () => {
  let handle;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    clearInterval(handle);
    jest.useRealTimers();
  });

  test('runs the task on every tick', async () => {
    const task = jest.fn().mockResolvedValue(undefined);

    handle = startInterval('test worker', task, 1000);

    await jest.advanceTimersByTimeAsync(3000);

    expect(task).toHaveBeenCalledTimes(3);
  });

  test('skips a tick while the previous run is still in progress', async () => {
    let release;
    const task = jest.fn().mockImplementation(() => new Promise((resolve) => (release = resolve)));

    handle = startInterval('test worker', task, 1000);

    await jest.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);

    // Two more ticks pass while the first run is still awaiting.
    await jest.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('Postponing the test worker iteration'));

    release();
    await jest.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  test('logs a failing task and keeps the worker alive', async () => {
    const task = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);

    handle = startInterval('test worker', task, 1000);

    await jest.advanceTimersByTimeAsync(2000);

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Error in the test worker iteration'));
    expect(task).toHaveBeenCalledTimes(2);
  });
});
