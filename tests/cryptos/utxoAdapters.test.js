jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const BtcCoin = require('../../helpers/cryptos/btc_utils');
const DashCoin = require('../../helpers/cryptos/dash_utils');
const DogeCoin = require('../../helpers/cryptos/doge_utils');

/**
 * Replaces a coin's node client with mocks, so no test touches the network.
 *
 * @param {object} coin Coin adapter
 * @returns {{request: jest.Mock, rpc: jest.Mock}}
 */
function stubClient(coin) {
  const client = { request: jest.fn(), rpc: jest.fn() };

  coin.client = client;

  return client;
}

describe('BtcCoin', () => {
  /** @type {BtcCoin} */
  let coin;
  let client;

  beforeEach(() => {
    coin = new BtcCoin('BTC');
    client = stubClient(coin);
  });

  test('derives a mainnet P2PKH address from the passphrase', () => {
    expect(coin.address).toMatch(/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/);
    expect(coin.isValidAddress(coin.address)).toBe(true);
  });

  test('counts unconfirmed movements in the balance, so change is spendable immediately', async () => {
    client.request.mockResolvedValue({
      chain_stats: { funded_txo_sum: 200000, spent_txo_sum: 50000 },
      mempool_stats: { funded_txo_sum: 40000, spent_txo_sum: 10000 },
    });

    await expect(coin.getBalance()).resolves.toBe(0.0018);
  });

  test('works with a node that reports no mempool stats', async () => {
    client.request.mockResolvedValue({ chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 0 } });

    await expect(coin.getBalance()).resolves.toBe(0.001);
  });

  test('serves a repeated balance request from cache', async () => {
    client.request.mockResolvedValue({ chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 0 } });

    await coin.getBalance();
    await coin.getBalance();

    expect(client.request).toHaveBeenCalledTimes(1);
  });

  test('returns the last known balance when the node is unreachable', async () => {
    client.request.mockResolvedValueOnce({ chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 0 } });
    await coin.getBalance();

    // Age the cached value past its lifetime, and make the node fail.
    coin.cache.balance.timestamp = Date.now() - coin.cache.balance.lifetime - 1;
    client.request.mockResolvedValue(undefined);

    await expect(coin.getBalance()).resolves.toBe(0.001);
  });

  test('turns the fee rate into a whole-transaction fee', async () => {
    client.request.mockResolvedValue({ 2: 10 });

    await coin.getFeeRate();

    // 3 inputs, 2 outputs and 10 bytes of overhead at 10 sat/vB.
    expect(coin.FEE).toBe(coin.fromSat(Math.ceil((3 * 181 + 2 * 34 + 10) * 10)));
  });

  test('falls back to a default fee when the node gives no estimate', async () => {
    client.request.mockResolvedValue({});

    await coin.getFeeRate();

    expect(coin.FEE).toBe(0.0001);
  });

  test('maps an Esplora transaction, converting satoshi to BTC', async () => {
    client.request.mockResolvedValue({
      txid: 'tx-1',
      fee: 10000,
      status: { confirmed: true, block_height: 800000, block_hash: 'block-1', block_time: 1700000000 },
      vin: [{ prevout: { scriptpubkey_address: 'sender' } }],
      vout: [
        { value: 50000, scriptpubkey_address: 'recipient' },
        { value: 40000, scriptpubkey_address: 'sender' },
      ],
    });

    const tx = await coin.getTransaction('tx-1');

    expect(tx.senderId).toBe('sender');
    expect(tx.recipientId).toBe('recipient');
    expect(tx.amount).toBe(0.0005);
    expect(tx.fee).toBe(0.0001);
    expect(tx.height).toBe(800000);
    expect(tx.status).toBe(true);
  });

  test('treats an unconfirmed transaction as pending, not failed', async () => {
    client.request.mockResolvedValue({
      txid: 'tx-1',
      fee: 10000,
      status: { confirmed: false },
      vin: [{ prevout: { scriptpubkey_address: 'sender' } }],
      vout: [{ value: 50000, scriptpubkey_address: 'recipient' }],
    });

    expect((await coin.getTransaction('tx-1')).status).toBeUndefined();
  });

  test('lists pending transfers to the bot for first-seen tracking', async () => {
    client.request.mockResolvedValue([
      {
        txid: 'tx-1',
        fee: 10000,
        status: { confirmed: false },
        vin: [{ prevout: { scriptpubkey_address: 'sender' } }],
        vout: [{ value: 50000, scriptpubkey_address: coin.address }],
      },
    ]);

    await expect(coin.getPendingIncomingTransactions()).resolves.toEqual([
      expect.objectContaining({ hash: 'tx-1', recipientId: coin.address, status: undefined }),
    ]);
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: `/address/${coin.address}/txs/mempool` }),
    );
  });

  test('returns undefined for a transaction the node does not know', async () => {
    client.request.mockResolvedValue(undefined);

    await expect(coin.getTransaction('missing')).resolves.toBeUndefined();
  });

  test('attaches the raw previous transaction to every unspent output', async () => {
    client.request.mockImplementation(({ endpoint }) => {
      if (endpoint.endsWith('/utxo')) {
        return Promise.resolve([
          { txid: 'a', vout: 0, value: 100000 },
          { txid: 'b', vout: 1, value: 200000 },
        ]);
      }

      return Promise.resolve(`raw-hex-of-${endpoint.split('/')[2]}`);
    });

    await expect(coin.getUnspents()).resolves.toEqual([
      { txid: 'a', vout: 0, amount: 100000, hex: 'raw-hex-of-a' },
      { txid: 'b', vout: 1, amount: 200000, hex: 'raw-hex-of-b' },
    ]);
  });

  test('skips an unspent output whose raw transaction cannot be fetched', async () => {
    client.request.mockImplementation(({ endpoint }) => {
      if (endpoint.endsWith('/utxo')) {
        return Promise.resolve([{ txid: 'a', vout: 0, value: 100000 }]);
      }

      return Promise.resolve(undefined);
    });

    await expect(coin.getUnspents()).resolves.toEqual([]);
  });

  test('broadcasts by posting the raw hex', async () => {
    client.request.mockResolvedValue('  broadcast-txid  ');

    await expect(coin.sendTransaction('deadbeef')).resolves.toBe('broadcast-txid');
    expect(client.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'post', data: 'deadbeef' }));
  });
});

describe('DashCoin', () => {
  /** @type {DashCoin} */
  let coin;
  let client;

  beforeEach(() => {
    coin = new DashCoin('DASH');
    client = stubClient(coin);
  });

  test('derives a Dash address from the passphrase', () => {
    expect(coin.isValidAddress(coin.address)).toBe(true);
    expect(coin.isValidAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(false);
  });

  test('reads the balance from getaddressbalance', async () => {
    client.rpc.mockResolvedValue({ balance: 100000000, received: 100000000 });

    await expect(coin.getBalance()).resolves.toBe(1);
    expect(client.rpc).toHaveBeenCalledWith('getaddressbalance', [coin.address]);
  });

  test('reads the chain tip from getblockcount', async () => {
    client.rpc.mockResolvedValue(2537270);

    await expect(coin.getLastBlockHeight()).resolves.toBe(2537270);
  });

  test('accepts a node that reports a single output address instead of a list', async () => {
    client.rpc.mockResolvedValue({
      txid: 'tx-1',
      confirmations: 6,
      time: 1700000000,
      vin: [{ address: 'sender', value: 1 }],
      vout: [{ value: 0.4, scriptPubKey: { address: 'recipient' } }],
      instantlock: true,
      instantlock_internal: true,
    });

    const tx = await coin.getTransaction('tx-1');

    expect(tx.recipientId).toBe('recipient');
    expect(tx.amount).toBe(0.4);
    expect(tx.instantlock).toBe(true);
  });

  test('looks up pending address transactions for first-seen tracking', async () => {
    client.rpc.mockImplementation((method) => {
      if (method === 'getaddressmempool') {
        return Promise.resolve([{ txid: 'tx-1' }, { txid: 'tx-1' }]);
      }

      return Promise.resolve({
        txid: 'tx-1',
        confirmations: 0,
        vin: [{ address: 'sender', value: 1 }],
        vout: [{ value: 0.4, scriptPubKey: { address: coin.address } }],
      });
    });

    await expect(coin.getPendingIncomingTransactions()).resolves.toEqual([
      expect.objectContaining({ hash: 'tx-1', recipientId: coin.address }),
    ]);
    expect(client.rpc).toHaveBeenCalledWith('getaddressmempool', [{ addresses: [coin.address] }]);
  });

  test('maps unspent outputs to the common shape and fetches their raw hex', async () => {
    client.rpc.mockImplementation((method) => {
      if (method === 'getaddressutxos') {
        return Promise.resolve([{ txid: 'a', outputIndex: 2, satoshis: 500000 }]);
      }

      return Promise.resolve('raw-hex');
    });

    await expect(coin.getUnspents()).resolves.toEqual([{ txid: 'a', vout: 2, amount: 500000, hex: 'raw-hex' }]);
  });

  test('broadcasts with sendrawtransaction', async () => {
    client.rpc.mockResolvedValue('dash-txid');

    await expect(coin.sendTransaction('deadbeef')).resolves.toBe('dash-txid');
    expect(client.rpc).toHaveBeenCalledWith('sendrawtransaction', ['deadbeef']);
  });
});

describe('DogeCoin', () => {
  /** @type {DogeCoin} */
  let coin;
  let client;

  beforeEach(() => {
    coin = new DogeCoin('DOGE');
    client = stubClient(coin);
  });

  test('derives a Dogecoin address from the passphrase', () => {
    expect(coin.isValidAddress(coin.address)).toBe(true);
  });

  test('charges the fixed one-DOGE fee', () => {
    expect(coin.FEE).toBe(1);
  });

  test('allows a fee rate high enough for that fixed fee to be extractable', () => {
    // One DOGE over a small transaction is a very high rate by Bitcoin standards.
    expect(coin.maximumFeeRate).toBeGreaterThan(coin.toSat(coin.FEE) / 226);
  });

  test('reads the balance in koinu', async () => {
    client.request.mockResolvedValue(150000000);

    await expect(coin.getBalance()).resolves.toBe(1.5);
  });

  test('treats a zero balance as a real answer, not a failure', async () => {
    client.request.mockResolvedValue(0);

    await expect(coin.getBalance()).resolves.toBe(0);
  });

  test('reads the chain tip from the node status', async () => {
    client.request.mockResolvedValue({ info: { blocks: 6370413 } });

    await expect(coin.getLastBlockHeight()).resolves.toBe(6370413);
  });

  test('maps an Insight transaction, whose amounts are already in DOGE', async () => {
    client.request.mockResolvedValue({
      txid: 'tx-1',
      confirmations: 10,
      time: 1700000000,
      fees: 1,
      blockhash: 'block-1',
      vin: [{ addr: 'sender', value: 100 }],
      vout: [
        { value: '40', scriptPubKey: { addresses: ['recipient'] } },
        { value: '59', scriptPubKey: { addresses: ['sender'] } },
      ],
    });

    const tx = await coin.getTransaction('tx-1');

    expect(tx.senderId).toBe('sender');
    expect(tx.recipientId).toBe('recipient');
    expect(tx.amount).toBe(40);
    expect(tx.fee).toBe(1);
  });

  test('filters the Insight address history down to pending incoming transactions', async () => {
    client.request.mockImplementation(({ endpoint }) => {
      if (endpoint.startsWith('/api/txs/')) {
        return Promise.resolve({ txs: [{ txid: 'pending' }, { txid: 'confirmed', confirmations: 2 }] });
      }

      return Promise.resolve({
        txid: 'pending',
        confirmations: 0,
        vin: [{ addr: 'sender', value: 2 }],
        vout: [{ value: '1', scriptPubKey: { addresses: [coin.address] } }],
      });
    });

    await expect(coin.getPendingIncomingTransactions()).resolves.toEqual([
      expect.objectContaining({ hash: 'pending', recipientId: coin.address }),
    ]);
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: expect.stringContaining(`/api/txs/?address=${coin.address}`) }),
    );
  });

  test('requests unspent outputs with the node cache disabled', async () => {
    client.request.mockImplementation(({ endpoint }) => {
      if (endpoint.includes('/utxo')) {
        return Promise.resolve([{ txid: 'a', vout: 0, amount: 5, satoshis: 500000000 }]);
      }

      return Promise.resolve({ rawtx: 'raw-hex' });
    });

    await expect(coin.getUnspents()).resolves.toEqual([{ txid: 'a', vout: 0, amount: 500000000, hex: 'raw-hex' }]);
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: expect.stringContaining('noCache=1') }),
    );
  });

  test('falls back to converting the DOGE amount when the node omits satoshis', async () => {
    client.request.mockImplementation(({ endpoint }) => {
      if (endpoint.includes('/utxo')) {
        return Promise.resolve([{ txid: 'a', vout: 0, amount: 5 }]);
      }

      return Promise.resolve({ rawtx: 'raw-hex' });
    });

    await expect(coin.getUnspents()).resolves.toEqual([{ txid: 'a', vout: 0, amount: 500000000, hex: 'raw-hex' }]);
  });

  test('broadcasts by posting rawtx and returns the txid', async () => {
    client.request.mockResolvedValue({ txid: 'doge-txid' });

    await expect(coin.sendTransaction('deadbeef')).resolves.toBe('doge-txid');
  });
});

describe('UTXO adapters share one interface', () => {
  test.each([
    ['BTC', () => new BtcCoin('BTC')],
    ['DASH', () => new DashCoin('DASH')],
    ['DOGE', () => new DogeCoin('DOGE')],
  ])('%s implements the methods the pipeline calls', (token, create) => {
    const coin = create();

    for (const method of [
      'getBalance',
      'getLastBlockHeight',
      'getTransaction',
      'getPendingIncomingTransactions',
      'getUnspents',
      'sendTransaction',
      'send',
      'isValidAddress',
      'formTxMessage',
      'logInitialState',
    ]) {
      expect(typeof coin[method]).toBe('function');
    }

    expect(coin.token).toBe(token);
    expect(coin.decimals).toBe(8);
    expect(coin.dustThreshold).toBeGreaterThan(0);
    expect(typeof coin.FEE).toBe('number');
  });
});
