jest.mock('axios');
jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const axios = require('axios');
const log = require('../../helpers/log');
const { NodeClient } = require('../../helpers/cryptos/nodeClient');

const NODES = ['https://node1.example', 'https://node2.example'];

/**
 * Builds an Axios-like error for a failed request.
 *
 * @param {string} message Error message
 * @param {object} [response] Response the server sent, if any
 * @returns {Error}
 */
function requestError(message, response) {
  const error = new Error(message);

  error.response = response;

  return error;
}

describe('NodeClient', () => {
  test('refuses to be built without nodes', () => {
    expect(() => new NodeClient('BTC', [])).toThrow('No nodes configured for BTC');
    expect(() => new NodeClient('BTC', undefined)).toThrow('No nodes configured for BTC');
  });

  test('strips trailing slashes so endpoints are not doubled up', async () => {
    axios.mockResolvedValue({ data: 'ok' });

    const client = new NodeClient('BTC', ['https://node1.example/']);

    await client.request({ endpoint: '/blocks/tip/height' });

    expect(axios).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://node1.example/blocks/tip/height' }));
  });

  test('returns the response body of the first node that answers', async () => {
    axios.mockResolvedValue({ data: { height: 1 } });

    const client = new NodeClient('BTC', NODES);

    await expect(client.request({ endpoint: '/x' })).resolves.toEqual({ height: 1 });
    expect(axios).toHaveBeenCalledTimes(1);
  });

  test('fails over to the next node and keeps using it afterwards', async () => {
    axios.mockRejectedValueOnce(requestError('ECONNREFUSED')).mockResolvedValue({ data: 'from node 2' });

    const client = new NodeClient('DOGE', NODES);

    await expect(client.request({ endpoint: '/api/status' })).resolves.toBe('from node 2');
    expect(client.node).toBe(NODES[1]);

    await client.request({ endpoint: '/api/status' });

    expect(axios).toHaveBeenLastCalledWith(expect.objectContaining({ url: `${NODES[1]}/api/status` }));
  });

  test('concurrent requests each try every node, never the same dead node twice', async () => {
    // The bot fires balance, height and fee requests at once. A cursor shared between
    // them and advanced on every failure made two requests retry the same dead node,
    // which is how a live DOGE balance was lost while the second node was healthy.
    axios.mockImplementation(({ url }) =>
      url.startsWith(NODES[0]) ? Promise.reject(requestError('ENOTFOUND')) : Promise.resolve({ data: 'ok' }),
    );

    const client = new NodeClient('DOGE', NODES);
    const results = await Promise.all([
      client.request({ endpoint: '/a' }),
      client.request({ endpoint: '/b' }),
      client.request({ endpoint: '/c' }),
    ]);

    expect(results).toEqual(['ok', 'ok', 'ok']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('remembers the node that worked, so later requests skip the dead one', async () => {
    axios.mockImplementation(({ url }) =>
      url.startsWith(NODES[0]) ? Promise.reject(requestError('ENOTFOUND')) : Promise.resolve({ data: 'ok' }),
    );

    const client = new NodeClient('DOGE', NODES);

    await client.request({ endpoint: '/a' });
    axios.mockClear();
    await client.request({ endpoint: '/b' });

    expect(axios).toHaveBeenCalledTimes(1);
    expect(axios).toHaveBeenCalledWith(expect.objectContaining({ url: `${NODES[1]}/b` }));
  });

  test('returns undefined and logs once when every node fails', async () => {
    axios.mockRejectedValue(requestError('ECONNREFUSED'));

    const client = new NodeClient('DOGE', NODES);

    await expect(client.request({ endpoint: '/api/status' })).resolves.toBeUndefined();
    expect(axios).toHaveBeenCalledTimes(NODES.length);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('every DOGE node failed'));
  });

  test('stays quiet when the caller reports the failure itself', async () => {
    axios.mockRejectedValue(requestError('ECONNREFUSED'));

    const client = new NodeClient('DOGE', NODES);

    await client.request({ endpoint: '/api/tx/unknown', quiet: true });

    expect(log.warn).not.toHaveBeenCalled();
  });

  test('includes the node reply in the failure message', async () => {
    axios.mockRejectedValue(requestError('Request failed', { status: 500, data: { error: 'internal' } }));

    const client = new NodeClient('BTC', ['https://node1.example']);

    await client.request({ endpoint: '/x' });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Node's reply: internal"));
  });

  test('rpc unwraps the result field', async () => {
    axios.mockResolvedValue({ data: { result: 2537270, error: null } });

    const client = new NodeClient('DASH', NODES);

    await expect(client.rpc('getblockcount')).resolves.toBe(2537270);
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'post', data: { method: 'getblockcount', params: [] } }),
    );
  });

  test('rpc returns undefined and logs when the node reports an RPC error', async () => {
    axios.mockResolvedValue({ data: { result: null, error: { code: -5, message: 'No such tx' } } });

    const client = new NodeClient('DASH', NODES);

    await expect(client.rpc('getrawtransaction', ['abc'])).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("DASH node returned an error for 'getrawtransaction'"),
    );
  });

  test('rpc stays quiet about an RPC error when asked', async () => {
    axios.mockResolvedValue({ data: { result: null, error: 'No such tx' } });

    const client = new NodeClient('DASH', NODES);

    await expect(client.rpc('getrawtransaction', ['abc'], { quiet: true })).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
