jest.mock('../../modules/api', () => ({ sendMessage: jest.fn() }));
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const { MessageType } = require('adamant-api');

const api = require('../../modules/api');
const log = require('../../helpers/log');
const config = require('../../modules/configReader');
const messenger = require('../../helpers/messenger');

const USER = 'U16655734187932477074';

describe('messenger.sendMessage', () => {
  test('sends an encrypted chat message', async () => {
    api.sendMessage.mockResolvedValue({ success: true, transactionId: 'tx-1' });

    await expect(messenger.sendMessage(USER, 'Hello')).resolves.toBe(true);
    expect(api.sendMessage).toHaveBeenCalledWith(config.passPhrase, USER, 'Hello', MessageType.Chat);
  });

  test('reports a rejected message without throwing', async () => {
    api.sendMessage.mockResolvedValue({ success: false, errorMessage: 'no public key' });

    await expect(messenger.sendMessage(USER, 'Hello')).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to send an ADM message'));
  });

  test('reports a network failure without throwing', async () => {
    api.sendMessage.mockRejectedValue(new Error('node down'));

    await expect(messenger.sendMessage(USER, 'Hello')).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to send an ADM message'));
  });

  test('does not send an empty message', async () => {
    await expect(messenger.sendMessage(USER, '')).resolves.toBe(false);
    await expect(messenger.sendMessage(USER, undefined)).resolves.toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('messenger.sendTransferMessage', () => {
  test('sends a rich message describing a transfer in another blockchain', async () => {
    api.sendMessage.mockResolvedValue({ success: true, transactionId: 'tx-1' });

    await expect(messenger.sendTransferMessage(USER, 'BTC', 0.001, 'btc-tx-1', 'Done!')).resolves.toBe(true);

    const [, , payload, type] = api.sendMessage.mock.calls[0];

    expect(type).toBe(MessageType.Rich);
    expect(JSON.parse(payload)).toEqual({
      type: 'btc_transaction',
      amount: '0.001',
      hash: 'btc-tx-1',
      comments: 'Done!',
    });
  });

  test('escapes a comment safely into the JSON payload', async () => {
    api.sendMessage.mockResolvedValue({ success: true, transactionId: 'tx-1' });

    await messenger.sendTransferMessage(USER, 'BTC', 0.001, 'btc-tx-1', 'He said "hi"\nand left');

    const payload = api.sendMessage.mock.calls[0][2];

    expect(() => JSON.parse(payload)).not.toThrow();
    expect(JSON.parse(payload).comments).toBe('He said "hi"\nand left');
  });

  test('reports a rejected transfer message', async () => {
    api.sendMessage.mockResolvedValue({ success: false, errorMessage: 'no public key' });

    await expect(messenger.sendTransferMessage(USER, 'BTC', 0.001, 'btc-tx-1', 'Done!')).resolves.toBe(false);
  });
});
