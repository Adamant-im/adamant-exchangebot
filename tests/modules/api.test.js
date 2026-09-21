// The real client module is loaded here on purpose: every other suite mocks it, which
// is how an export that dropped every SDK method once reached a release branch.
jest.mock('axios');
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const axios = require('axios');

/** @type {import('adamant-api').AdamantApi} */
let api;

beforeAll(() => {
  // The client health-checks its nodes at once and then on a timer; neither may reach
  // the network or keep the test process alive.
  jest.useFakeTimers();
  axios.mockRejectedValue(new Error('network disabled in tests'));
  axios.get = jest.fn().mockRejectedValue(new Error('network disabled in tests'));

  api = require('../../modules/api');
});

afterAll(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('modules/api', () => {
  test.each([
    'onReady',
    'get',
    'post',
    'getTransactions',
    'getTransaction',
    'getBlocks',
    'getAccountInfo',
    'sendMessage',
  ])('exposes the SDK method %s', (method) => {
    expect(typeof api[method]).toBe('function');
  });

  test('reads KVS records with plain query parameters', async () => {
    const get = jest.spyOn(api, 'get').mockResolvedValue({ success: true, transactions: [] });
    const params = { senderId: 'U1', key: 'eth:address', orderBy: 'timestamp:desc', limit: 100 };

    await api.getKvsRecords(params);

    // No `and:` prefixes: released nodes drop them on /api/states/get and answer with
    // the whole network's KVS records (Adamant-im/adamant#277).
    expect(get).toHaveBeenCalledWith('states/get', params);
  });
});
