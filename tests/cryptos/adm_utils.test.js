jest.mock('../../modules/api', () => ({
  getBlocks: jest.fn(),
  getAccountInfo: jest.fn(),
  getTransaction: jest.fn(),
  sendMessage: jest.fn(),
}));
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
const AdmCoin = require('../../helpers/cryptos/adm_utils');
const { SAT } = require('../../helpers/const');

const USER = 'U16655734187932477074';

describe('AdmCoin', () => {
  /** @type {AdmCoin} */
  let adm;

  beforeEach(() => {
    adm = new AdmCoin();
  });

  test('uses the bot’s own ADAMANT account', () => {
    expect(adm.token).toBe('ADM');
    expect(adm.account.address).toBe(config.address);
    expect(adm.account.keyPair).toBe(config.keyPair);
  });

  test('validates ADAMANT addresses', () => {
    expect(adm.isValidAddress(USER)).toBe(true);
    expect(adm.isValidAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(false);
    expect(adm.isValidAddress('')).toBe(false);
  });

  test('charges the fixed ADAMANT transfer fee', () => {
    expect(adm.FEE).toBe(0.5);
  });

  test('reads the balance in ADM and caches it', async () => {
    api.getAccountInfo.mockResolvedValue({ success: true, account: { balance: 5 * SAT } });

    await expect(adm.getBalance()).resolves.toBe(5);
    await adm.getBalance();

    expect(api.getAccountInfo).toHaveBeenCalledTimes(1);
    expect(api.getAccountInfo).toHaveBeenCalledWith({ address: config.address });
  });

  test('treats a zero balance as a real answer', async () => {
    api.getAccountInfo.mockResolvedValue({ success: true, account: { balance: 0 } });

    await expect(adm.getBalance()).resolves.toBe(0);
  });

  test('returns the last known balance when the node request fails', async () => {
    api.getAccountInfo.mockResolvedValueOnce({ success: true, account: { balance: SAT } });
    await adm.getBalance();

    adm.cache.balance.timestamp = Date.now() - adm.cache.balance.lifetime - 1;
    api.getAccountInfo.mockResolvedValue({ success: false, errorMessage: 'node down' });

    await expect(adm.getBalance()).resolves.toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to get account info'));
  });

  test('setting the balance updates the cache, so the next payout sees the funds spent', () => {
    adm.balance = 10;
    expect(adm.balance).toBe(10);

    adm.balance -= 2.5;
    expect(adm.balance).toBe(7.5);
  });

  test('ignores an attempt to set a negative or non-numeric balance', () => {
    adm.balance = 10;
    adm.balance = -1;
    adm.balance = 'lots';

    expect(adm.balance).toBe(10);
  });

  test('reads the chain height from the last block', async () => {
    api.getBlocks.mockResolvedValue({ success: true, blocks: [{ height: 54632450 }] });

    await expect(adm.getLastBlockHeight()).resolves.toBe(54632450);
    expect(api.getBlocks).toHaveBeenCalledWith({ limit: 1 });
  });

  test('returns undefined when the node cannot give the last block', async () => {
    api.getBlocks.mockResolvedValue({ success: false, errorMessage: 'node down' });

    await expect(adm.getLastBlockHeight()).resolves.toBeUndefined();
  });

  test('maps a transaction into the bot’s common shape, converting sats to ADM', async () => {
    api.getTransaction.mockResolvedValue({
      success: true,
      transaction: {
        id: 'tx-1',
        height: 54632450,
        blockId: 'block-1',
        timestamp: 100,
        senderId: USER,
        recipientId: config.address,
        confirmations: 4,
        amount: 2.5 * SAT,
        fee: 0.5 * SAT,
      },
    });

    const tx = await adm.getTransaction('tx-1');

    expect(tx).toMatchObject({
      status: true,
      height: 54632450,
      hash: 'tx-1',
      senderId: USER,
      recipientId: config.address,
      confirmations: 4,
      amount: 2.5,
      fee: 0.5,
    });
  });

  test('leaves the status undefined while a transaction has no confirmations', async () => {
    api.getTransaction.mockResolvedValue({
      success: true,
      transaction: { id: 'tx-1', confirmations: 0, amount: 0, fee: 0, senderId: USER, recipientId: config.address },
    });

    expect((await adm.getTransaction('tx-1')).status).toBeUndefined();
  });

  test('returns null for a transaction the node does not know', async () => {
    api.getTransaction.mockResolvedValue({ success: false, errorMessage: 'not found' });

    await expect(adm.getTransaction('missing')).resolves.toBeNull();
  });

  test('sends ADM with the amount marked as ADM rather than sats', async () => {
    api.sendMessage.mockResolvedValue({ success: true, transactionId: 'tx-2' });

    const result = await adm.send({ address: USER, value: 2.5, comment: 'Done!' });

    expect(result).toEqual({ success: true, hash: 'tx-2' });
    expect(api.sendMessage).toHaveBeenCalledWith(config.passPhrase, USER, 'Done!', MessageType.Chat, 2.5, true);
  });

  test('refuses to send to an address that is not an ADAMANT address', async () => {
    const result = await adm.send({ address: '0xabc', value: 2.5, comment: 'Done!' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is not a valid ADM address/);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  test('reports a rejected transfer without throwing', async () => {
    api.sendMessage.mockResolvedValue({ success: false, errorMessage: 'Account does not have enough ADM' });

    const result = await adm.send({ address: USER, value: 2.5, comment: 'Done!' });

    expect(result).toEqual({ success: false, error: 'Account does not have enough ADM' });
  });

  test('treats a transport failure as an ambiguous outcome', async () => {
    api.sendMessage.mockResolvedValue({ success: false, errorMessage: 'timeout of 15000ms exceeded' });

    const result = await adm.send({ address: USER, value: 2.5, comment: 'Done!' });

    expect(result).toEqual({ success: false, isAmbiguous: true, error: 'timeout of 15000ms exceeded' });
  });

  test('treats a duplicate response after a lost POST reply as an ambiguous outcome', async () => {
    api.sendMessage.mockResolvedValue({ success: false, errorMessage: 'Transaction already exists' });

    const result = await adm.send({ address: USER, value: 2.5, comment: 'Done!' });

    expect(result).toEqual({ success: false, isAmbiguous: true, error: 'Transaction already exists' });
  });

  test('describes a transaction in one readable line', () => {
    const message = adm.formTxMessage({
      hash: 'tx-1',
      amount: 2.5,
      senderId: config.address,
      recipientId: USER,
      height: 1,
      confirmations: 4,
      fee: 0.5,
    });

    expect(message).toContain('Tx tx-1 for 2.5 ADM from Me to U16655734187932477074');
    expect(message).toContain('4 confirmations');
  });
});
