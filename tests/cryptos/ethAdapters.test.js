jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const ethers = require('ethers');

const EthCoin = require('../../helpers/cryptos/eth_utils');
const Erc20Coin = require('../../helpers/cryptos/erc20_utils');
const erc20models = require('../../helpers/cryptos/erc20_models');
const log = require('../../helpers/log');

const RECIPIENT = '0x651a2d48211428be3ffecea7a9aceeef250b019f';
const ERC20_INTERFACE = new ethers.Interface([
  'function transfer(address to, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/**
 * Builds a `Transfer` log entry the way a node would return it.
 *
 * @param {string} contract Token contract address
 * @param {string} from Sender address
 * @param {string} to Recipient address
 * @param {bigint} value Amount, in the token's smallest unit
 * @returns {{address: string, topics: string[], data: string}}
 */
function transferLog(contract, from, to, value) {
  const encoded = ERC20_INTERFACE.encodeEventLog('Transfer', [from, to, value]);

  return { address: contract, topics: encoded.topics, data: encoded.data };
}

/**
 * Replaces a coin's network access with mocks.
 *
 * @param {EthCoin} coin Coin adapter
 * @returns {{provider: object, wallet: object, contract: object|undefined}}
 */
function stubNetwork(coin) {
  const provider = {
    getFeeData: jest.fn(),
    getBlock: jest.fn(),
    getBalance: jest.fn(),
    getTransaction: jest.fn(),
    getTransactionReceipt: jest.fn(),
  };
  const wallet = { sendTransaction: jest.fn() };

  coin.provider = provider;
  coin.wallet = wallet;

  if (coin.contract) {
    coin.contract = { balanceOf: jest.fn(), transfer: jest.fn() };
  }

  return { provider, wallet, contract: coin.contract };
}

describe('EthCoin', () => {
  /** @type {EthCoin} */
  let eth;
  let network;

  beforeEach(() => {
    eth = new EthCoin('ETH');
    network = stubNetwork(eth);
  });

  test('derives an Ethereum address from the passphrase', () => {
    expect(eth.account.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(eth.isValidAddress(eth.account.address)).toBe(true);
    expect(eth.isValidAddress('not-an-address')).toBe(false);
  });

  test('uses a nonce manager so ETH and ERC-20 sends share one nonce sequence', () => {
    const managed = new EthCoin('ETH');

    expect(managed.wallet).toBeInstanceOf(ethers.NonceManager);
  });

  test('converts between wei and ETH', () => {
    expect(eth.fromSat(10n ** 18n)).toBe(1);
    expect(eth.toSat(1)).toBe(10n ** 18n);
    expect(eth.toSat('0.5')).toBe(5n * 10n ** 17n);
  });

  test('returns undefined rather than zero for a missing amount', () => {
    expect(eth.fromSat(undefined)).toBeUndefined();
    expect(eth.fromSat(null)).toBeUndefined();
  });

  test('has no fee estimate until the gas price is known', () => {
    expect(eth.FEE).toBe(0);
  });

  test('computes the fee from the gas price, gas limit and reliability margin', async () => {
    network.provider.getFeeData.mockResolvedValue({ gasPrice: 20000000000n });

    await eth.updateGasPrice();

    // 22 000 gas at 20 gwei is 0.00044 ETH, times the 1.3 margin.
    expect(eth.FEE).toBeCloseTo(0.00044 * 1.3, 12);
  });

  test('keeps the previous gas price when the node does not return one', async () => {
    network.provider.getFeeData.mockResolvedValue({ gasPrice: 20000000000n });
    await eth.updateGasPrice();

    network.provider.getFeeData.mockResolvedValue({ gasPrice: null });
    await eth.updateGasPrice();

    expect(eth.gasPrice).toBe(20000000000n);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to get the Ether gas price'));
  });

  test('survives a provider that throws while fetching the gas price', async () => {
    network.provider.getFeeData.mockRejectedValue(new Error('node down'));

    await expect(eth.updateGasPrice()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Error while getting the Ether gas price'));
  });

  test('reads the balance from the provider and caches it', async () => {
    network.provider.getBalance.mockResolvedValue(10n ** 18n);

    await expect(eth.getBalance()).resolves.toBe(1);
    await eth.getBalance();

    expect(network.provider.getBalance).toHaveBeenCalledTimes(1);
  });

  test('returns the last known balance when the provider fails', async () => {
    network.provider.getBalance.mockResolvedValueOnce(10n ** 18n);
    await eth.getBalance();

    eth.cache.balance.timestamp = Date.now() - eth.cache.balance.lifetime - 1;
    network.provider.getBalance.mockRejectedValue(new Error('node down'));

    await expect(eth.getBalance()).resolves.toBe(1);
  });

  test('sends ETH through the wallet with the computed gas limit', async () => {
    network.wallet.sendTransaction.mockResolvedValue({ hash: '0xhash' });

    await expect(eth.send({ address: RECIPIENT, value: 0.5 })).resolves.toEqual({ success: true, hash: '0xhash' });
    expect(network.wallet.sendTransaction).toHaveBeenCalledWith({
      to: RECIPIENT,
      value: 5n * 10n ** 17n,
      gasLimit: Math.round(22000 * 1.3),
    });
  });

  test('raises the gas limit on each retry', async () => {
    network.wallet.sendTransaction.mockResolvedValue({ hash: '0xhash' });

    await eth.send({ address: RECIPIENT, value: 0.5, try: 2 });

    expect(network.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gasLimit: Math.round(22000 * 1.3 * 2) }),
    );
  });

  test('refuses to send to an invalid address', async () => {
    const result = await eth.send({ address: 'not-an-address', value: 0.5 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is not a valid Ethereum address/);
    expect(network.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  test('reports a rejected transaction instead of throwing', async () => {
    network.wallet.sendTransaction.mockRejectedValue(new Error('insufficient funds'));

    const result = await eth.send({ address: RECIPIENT, value: 0.5 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/insufficient funds/);
  });

  test('merges a receipt and a transaction into one description of an ETH transfer', async () => {
    network.provider.getTransactionReceipt.mockResolvedValue({
      hash: '0xhash',
      status: 1,
      blockNumber: 17975212,
      blockHash: '0xblock',
      from: '0xsender',
      to: RECIPIENT,
      gasUsed: 21000n,
      gasPrice: 13461439079n,
      logs: [],
    });
    network.provider.getTransaction.mockResolvedValue({
      hash: '0xhash',
      from: '0xsender',
      to: RECIPIENT,
      value: 5n * 10n ** 17n,
      nonce: 3,
      data: '0x',
    });
    network.provider.getBlock.mockResolvedValue({ timestamp: 1692767195 });

    const tx = await eth.getTransaction('0xhash');

    expect(tx.status).toBe(true);
    expect(tx.amount).toBe(0.5);
    expect(tx.height).toBe(17975212);
    expect(tx.timestamp).toBe(1692767195000);
    expect(tx.nonce).toBe(3);
    expect(tx.gasUsed).toBe(21000);
  });

  test('marks a reverted transaction as failed', async () => {
    network.provider.getTransactionReceipt.mockResolvedValue({
      hash: '0xhash',
      status: 0,
      blockNumber: 1,
      from: '0xsender',
      to: RECIPIENT,
      gasUsed: 21000n,
      logs: [],
    });
    network.provider.getTransaction.mockResolvedValue(null);

    expect((await eth.getTransaction('0xhash')).status).toBe(false);
  });

  test('returns undefined while the transaction is unknown to the node', async () => {
    network.provider.getTransactionReceipt.mockResolvedValue(null);
    network.provider.getTransaction.mockResolvedValue(null);

    await expect(eth.getTransaction('0xhash')).resolves.toBeUndefined();
  });

  test('decodes an ERC-20 transfer from the receipt logs, using that token’s decimals', async () => {
    network.provider.getTransactionReceipt.mockResolvedValue({
      hash: '0xhash',
      status: 1,
      blockNumber: 1,
      from: '0xsender',
      to: erc20models.USDT.sc,
      gasUsed: 46097n,
      gasPrice: 1n,
      // 100 USDT, which has 6 decimals — not the 18 an ETH-centric conversion would use.
      logs: [transferLog(erc20models.USDT.sc, '0x' + '1'.repeat(40), RECIPIENT, 100000000n)],
    });
    network.provider.getTransaction.mockResolvedValue(null);

    const tx = await eth.getTransaction('0xhash');

    expect(tx.amount).toBe(100);
    expect(tx.contract).toBe(erc20models.USDT.sc);
    expect(tx.recipientId.toLowerCase()).toBe(RECIPIENT);
  });

  test('decodes a pending ERC-20 transfer from the calldata', async () => {
    network.provider.getTransactionReceipt.mockResolvedValue(null);
    network.provider.getTransaction.mockResolvedValue({
      hash: '0xhash',
      from: '0xsender',
      to: erc20models.DAI.sc,
      value: 0n,
      nonce: 1,
      // 2 DAI, which has 18 decimals.
      data: ERC20_INTERFACE.encodeFunctionData('transfer', [RECIPIENT, 2n * 10n ** 18n]),
    });

    const tx = await eth.getTransaction('0xhash');

    expect(tx.amount).toBe(2);
    expect(tx.recipientId.toLowerCase()).toBe(RECIPIENT);
  });

  test('ignores logs from contracts the bot does not know', async () => {
    network.provider.getTransactionReceipt.mockResolvedValue({
      hash: '0xhash',
      status: 1,
      blockNumber: 1,
      from: '0xsender',
      to: '0x' + '9'.repeat(40),
      gasUsed: 1n,
      logs: [transferLog('0x' + '9'.repeat(40), '0x' + '1'.repeat(40), RECIPIENT, 1n)],
    });
    network.provider.getTransaction.mockResolvedValue(null);

    expect((await eth.getTransaction('0xhash')).contract).toBeUndefined();
  });

  test('describes a transaction in one readable line', () => {
    const message = eth.formTxMessage({
      hash: '0xhash',
      amount: 100,
      contract: erc20models.USDT.sc,
      senderId: '0xsender',
      recipientId: eth.account.address,
      status: true,
      height: 17975212,
      gasUsed: 46097,
      gasPrice: 13461439079n,
      nonce: 3,
    });

    expect(message).toContain('for 100 USDT');
    expect(message).toContain('to Me');
    expect(message).toContain('via the USDT contract');
    expect(message).toContain('is accepted');
    expect(message).toContain('ETH fee');
  });
});

describe('Erc20Coin', () => {
  /** @type {EthCoin} */
  let eth;
  /** @type {Erc20Coin} */
  let usdt;
  let ethNetwork;

  beforeEach(() => {
    eth = new EthCoin('ETH');
    ethNetwork = stubNetwork(eth);
    usdt = new Erc20Coin('USDT', eth);
    usdt.contract = { balanceOf: jest.fn(), transfer: jest.fn() };
  });

  test('shares the wallet and provider with the ETH adapter', () => {
    expect(usdt.account).toBe(eth.account);
    expect(usdt.provider).toBe(eth.provider);
    expect(usdt.wallet).toBe(eth.wallet);
  });

  test('uses the token’s own decimals', () => {
    expect(usdt.decimals).toBe(6);
    expect(usdt.toSat(15.123456)).toBe(15123456n);
    expect(usdt.fromSat(15123456n)).toBe(15.123456);
  });

  test('drops precision beyond the token’s decimals instead of throwing', () => {
    expect(usdt.toSat(15.12345678)).toBe(15123457n);
  });

  test('refuses a token that is not described in erc20_models', () => {
    expect(() => new Erc20Coin('NOPE', eth)).toThrow(/No ERC-20 model found for NOPE/);
  });

  test('reads the balance from the token contract', async () => {
    usdt.contract.balanceOf.mockResolvedValue(15123456n);

    await expect(usdt.getBalance()).resolves.toBe(15.123456);
    expect(usdt.contract.balanceOf).toHaveBeenCalledWith(eth.account.address);
  });

  test('pays its fee in ETH, with the larger contract-call margin', async () => {
    ethNetwork.provider.getFeeData.mockResolvedValue({ gasPrice: 20000000000n });
    await eth.updateGasPrice();

    expect(usdt.FEE).toBeCloseTo(eth.FEE * (3.0 / 1.3), 12);
  });

  test('sends tokens through the contract', async () => {
    usdt.contract.transfer.mockResolvedValue({ hash: '0xhash' });

    await expect(usdt.send({ address: RECIPIENT, value: 100 })).resolves.toEqual({ success: true, hash: '0xhash' });
    expect(usdt.contract.transfer).toHaveBeenCalledWith(RECIPIENT, 100000000n, {
      gasLimit: Math.round(22000 * 3.0),
    });
  });

  test('delegates the chain height to the ETH adapter', async () => {
    eth.getLastBlock = jest.fn().mockResolvedValue({ number: 17975212 });

    await expect(usdt.getLastBlockHeight()).resolves.toBe(17975212);
  });
});

describe('erc20_models', () => {
  test('every token has a contract address and plausible decimals', () => {
    for (const [symbol, model] of Object.entries(erc20models)) {
      expect(model.token).toBe(symbol);
      expect(model.sc).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(Number.isInteger(model.decimals)).toBe(true);
      expect(model.decimals).toBeGreaterThan(0);
      expect(model.decimals).toBeLessThanOrEqual(18);
    }
  });

  test('contract addresses are unique', () => {
    const addresses = Object.values(erc20models).map((model) => model.sc.toLowerCase());

    expect(new Set(addresses).size).toBe(addresses.length);
  });

  test('the model list is frozen', () => {
    expect(Object.isFrozen(erc20models)).toBe(true);
  });
});
