const fs = require('fs');

const config = require('../../modules/configReader');
const log = require('../../helpers/log');

let consoleSpy;

beforeEach(() => {
  consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  config.log_level = 'none';
});

/**
 * Returns the text of every line written to the console during a test.
 *
 * @returns {string[]}
 */
function writtenLines() {
  return consoleSpy.mock.calls.map((call) => call[call.length - 1]);
}

describe('log levels', () => {
  test('at "log" everything is written', () => {
    config.log_level = 'log';

    log.error('an error');
    log.warn('a warning');
    log.info('some info');
    log.log('a detail');

    expect(writtenLines()).toEqual(['an error', 'a warning', 'some info', 'a detail']);
  });

  test('at "trace" debug and trace output are written too', () => {
    config.log_level = 'trace';

    log.error('an error');
    log.warn('a warning');
    log.info('some info');
    log.log('a detail');
    log.debug('a debug line');
    log.trace('a trace line');

    expect(writtenLines()).toEqual(['an error', 'a warning', 'some info', 'a detail', 'a debug line', 'a trace line']);
  });

  test('at "warn" only errors and warnings are written', () => {
    config.log_level = 'warn';

    log.error('an error');
    log.warn('a warning');
    log.info('some info');
    log.log('a detail');

    expect(writtenLines()).toEqual(['an error', 'a warning']);
  });

  test('at "debug" trace output stays hidden', () => {
    config.log_level = 'debug';

    log.debug('a debug line');
    log.trace('a trace line');

    expect(writtenLines()).toEqual(['a debug line']);
  });

  test('at "none" nothing is written, not even errors', () => {
    config.log_level = 'none';

    log.error('an error');
    log.warn('a warning');

    expect(writtenLines()).toEqual([]);
  });

  test('an unknown level is treated as "none" rather than as most verbose', () => {
    config.log_level = 'verbose';

    log.error('an error');

    expect(writtenLines()).toEqual([]);
  });

  test('each line is prefixed with its level and a timestamp', () => {
    config.log_level = 'log';

    log.warn('a warning');

    expect(consoleSpy.mock.calls[0][1]).toMatch(/^warn\|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('log redaction', () => {
  test('the bot’s passphrase never reaches the output', () => {
    config.log_level = 'log';

    log.error(`Something went wrong with ${config.passPhrase} while signing`);

    const line = writtenLines()[0];

    expect(line).not.toContain(config.passPhrase);
    expect(line).toContain('<passphrase hidden>');
  });

  test('redaction survives a passphrase embedded several times', () => {
    config.log_level = 'log';

    log.error(`${config.passPhrase} and again ${config.passPhrase}`);

    expect(writtenLines()[0]).toBe('<passphrase hidden> and again <passphrase hidden>');
  });

  test('a non-string value is logged without throwing', () => {
    config.log_level = 'log';

    log.error(new Error('boom'));
    log.log({ a: 1 });

    expect(writtenLines()).toEqual(['Error: boom', '[object Object]']);
  });
});

describe('log side effects', () => {
  test('a test run writes no log files', () => {
    config.log_level = 'log';

    const writeSpy = jest.spyOn(fs, 'createWriteStream');

    log.error('an error');

    expect(writeSpy).not.toHaveBeenCalled();
  });
});
