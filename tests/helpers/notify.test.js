jest.mock('axios');
jest.mock('../../modules/api', () => ({ sendMessage: jest.fn() }));
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const axios = require('axios');

const api = require('../../modules/api');
const log = require('../../helpers/log');

/**
 * Loads the notifier with a given config, which it reads once at require time.
 *
 * @param {object} overrides Config fields to set before loading
 * @returns {Function} The notifier
 */
function loadNotify(overrides) {
  let notify;

  jest.isolateModules(() => {
    const config = require('../../modules/configReader');

    Object.assign(config, overrides);
    notify = require('../../helpers/notify');
  });

  return notify;
}

describe('notify', () => {
  test('writes the message to the log at the given level, without Markdown', () => {
    const notify = loadNotify({ slack: '', adamant_notify: '' });

    notify('The *bot* has **started**', 'info');

    expect(log.info).toHaveBeenCalledWith('The bot has started');
  });

  test('preserves spaces when removing Markdown around a phrase', () => {
    const notify = loadNotify({ slack: '', adamant_notify: '' });

    notify('*Exchange Bot started* for the address _U14172822264918400879_.', 'info');

    expect(log.info).toHaveBeenCalledWith('Exchange Bot started for the address U14172822264918400879.');
  });

  test('sends nothing anywhere when neither channel is configured', () => {
    const notify = loadNotify({ slack: '', adamant_notify: '' });

    notify('Something happened', 'warn');

    expect(axios.post).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  test('stays silent in silent mode even when the channels are configured', () => {
    const notify = loadNotify({
      slack: 'https://hooks.slack.com/services/T000/B000/XXXX',
      adamant_notify: 'U16655734187932477074',
    });

    notify('Something happened', 'warn', true);

    expect(log.warn).toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  test('posts to Slack with the colour of the message level', async () => {
    axios.post.mockResolvedValue({ data: 'ok' });

    const notify = loadNotify({ slack: 'https://hooks.slack.com/services/T000/B000/XXXX', adamant_notify: '' });

    notify('Something **broke**', 'error');
    await Promise.resolve();

    const [url, body] = axios.post.mock.calls[0];

    expect(url).toBe('https://hooks.slack.com/services/T000/B000/XXXX');
    expect(body.attachments[0].color).toBe('#FF0000');
    expect(body.attachments[0].text).toBe('Something *broke*');
  });

  test('ignores a webhook that is only the placeholder prefix', () => {
    const notify = loadNotify({ slack: 'https://hooks.slack.com/services/', adamant_notify: '' });

    notify('Something happened', 'warn');

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('ignores a webhook pointing somewhere other than Slack', () => {
    const notify = loadNotify({ slack: 'https://example.com/collect', adamant_notify: '' });

    notify('Something happened', 'warn');

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('sends an ADAMANT message to the operator’s address', async () => {
    api.sendMessage.mockResolvedValue({ success: true, transactionId: 'tx-1' });

    const notify = loadNotify({ slack: '', adamant_notify: 'U16655734187932477074' });

    notify('Something *broke*', 'error');
    await Promise.resolve();

    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'U16655734187932477074',
      expect.stringContaining('error| Something **broke**'),
      expect.anything(),
    );
  });

  test('ignores a notification address that is not an ADM address', () => {
    const notify = loadNotify({ slack: '', adamant_notify: '0xabc' });

    notify('Something happened', 'warn');

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('is not an ADM address'));
  });

  test('never lets a notification failure escape to the caller', async () => {
    axios.post.mockRejectedValue(new Error('slack down'));
    api.sendMessage.mockRejectedValue(new Error('node down'));

    const notify = loadNotify({
      slack: 'https://hooks.slack.com/services/T000/B000/XXXX',
      adamant_notify: 'U16655734187932477074',
    });

    expect(() => notify('Something happened', 'error')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
