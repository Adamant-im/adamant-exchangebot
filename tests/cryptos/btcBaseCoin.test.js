jest.mock('../../helpers/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  log: jest.fn(),
}));

const bitcoin = require('bitcoinjs-lib');

const BtcCoin = require('../../helpers/cryptos/btc_utils');
const log = require('../../helpers/log');
const { createFundingUtxo, decodeOutputs } = require('../fixtures/utxo');

/** A mainnet P2PKH address that is not the bot's own. */
const RECIPIENT = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

describe('BtcBaseCoin unit conversion', () => {
  const coin = new BtcCoin('BTC');

  test('fromSat converts satoshi to BTC', () => {
    expect(coin.fromSat(100000000)).toBe(1);
    expect(coin.fromSat(1)).toBe(0.00000001);
    expect(coin.fromSat(0)).toBe(0);
  });

  test('toSat converts BTC to satoshi without losing a satoshi to floating point', () => {
    expect(coin.toSat(1)).toBe(100000000);
    expect(coin.toSat(0.1)).toBe(10000000);
    expect(coin.toSat(0.00000001)).toBe(1);
    expect(coin.toSat(2.675)).toBe(267500000);
  });

  test('conversion round-trips', () => {
    for (const value of [0.00000001, 0.1, 1.23456789, 21000000]) {
      expect(coin.fromSat(coin.toSat(value))).toBe(value);
    }
  });

  test('both reject values that are not numbers, so a missing balance is never read as zero', () => {
    for (const value of [null, undefined, '', 'abc', NaN]) {
      expect(coin.fromSat(value)).toBeUndefined();
      expect(coin.toSat(value)).toBeUndefined();
    }
  });
});

describe('BtcBaseCoin.buildTransaction', () => {
  /** @type {BtcCoin} */
  let coin;

  beforeEach(() => {
    coin = new BtcCoin('BTC');
  });

  test('builds a signed transaction with a change output back to the bot', () => {
    const utxo = createFundingUtxo(coin.address, coin.account.network, 100000);
    const hex = coin.buildTransaction(RECIPIENT, 0.0005, [utxo], 0.0001);
    const outputs = decodeOutputs(hex, coin.account.network);

    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toEqual({ address: RECIPIENT, value: 50000 });
    // 100 000 in, 50 000 out, 10 000 fee.
    expect(outputs[1]).toEqual({ address: coin.address, value: 40000 });
  });

  test('produces a transaction with valid signatures', () => {
    const utxo = createFundingUtxo(coin.address, coin.account.network, 100000);
    const hex = coin.buildTransaction(RECIPIENT, 0.0005, [utxo], 0.0001);
    const tx = bitcoin.Transaction.fromHex(hex);

    expect(tx.ins).toHaveLength(1);
    expect(tx.ins[0].script.length).toBeGreaterThan(0);
    expect(tx.getId()).toMatch(/^[0-9a-f]{64}$/);
  });

  test('omits a change output that would be dust, paying it to the miner instead', () => {
    // 50 000 in, 49 500 out, 400 fee leaves 100 satoshi — below the 546 dust threshold.
    const utxo = createFundingUtxo(coin.address, coin.account.network, 50000);
    const hex = coin.buildTransaction(RECIPIENT, 0.000495, [utxo], 0.000004);
    const outputs = decodeOutputs(hex, coin.account.network);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toEqual({ address: RECIPIENT, value: 49500 });
  });

  test('adds only as many inputs as the transfer needs', () => {
    const utxos = [
      createFundingUtxo(coin.address, coin.account.network, 100000),
      createFundingUtxo(coin.address, coin.account.network, 200000),
      createFundingUtxo(coin.address, coin.account.network, 300000),
    ];
    const hex = coin.buildTransaction(RECIPIENT, 0.0005, utxos, 0.0001);

    expect(bitcoin.Transaction.fromHex(hex).ins).toHaveLength(1);
  });

  test('combines inputs when one is not enough', () => {
    const utxos = [
      createFundingUtxo(coin.address, coin.account.network, 30000),
      createFundingUtxo(coin.address, coin.account.network, 40000),
      createFundingUtxo(coin.address, coin.account.network, 50000),
    ];
    const hex = coin.buildTransaction(RECIPIENT, 0.0006, utxos, 0.0001);

    expect(bitcoin.Transaction.fromHex(hex).ins).toHaveLength(2);
  });

  test('refuses to build a transaction the unspent outputs cannot cover', () => {
    const utxo = createFundingUtxo(coin.address, coin.account.network, 50000);

    expect(() => coin.buildTransaction(RECIPIENT, 1, [utxo], 0.0001)).toThrow(/Not enough unspent outputs/);
  });

  test('refuses an input with no raw transaction, which PSBT cannot sign', () => {
    const utxo = createFundingUtxo(coin.address, coin.account.network, 100000);

    expect(() => coin.buildTransaction(RECIPIENT, 0.0005, [{ ...utxo, hex: undefined }], 0.0001)).toThrow(
      /No raw transaction/,
    );
  });

  test('refuses an address from another network', () => {
    const utxo = createFundingUtxo(coin.address, coin.account.network, 100000);

    // A Dogecoin address; `toOutputScript` rejects it for the Bitcoin network.
    expect(() => coin.buildTransaction('DKyRokgWn1jkxFjBm7nNh5ALZXywSGWJYh', 0.0005, [utxo], 0.0001)).toThrow();
  });
});

describe('BtcBaseCoin.createTransaction', () => {
  test('returns hex and the transaction id that hex actually has', async () => {
    const coin = new BtcCoin('BTC');
    const utxo = createFundingUtxo(coin.address, coin.account.network, 100000);

    coin.getUnspents = jest.fn().mockResolvedValue([utxo]);

    const { hex, txid } = await coin.createTransaction(RECIPIENT, 0.0005, 0.0001);

    expect(txid).toBe(bitcoin.Transaction.fromHex(hex).getId());
  });

  test('throws when there are no unspent outputs at all', async () => {
    const coin = new BtcCoin('BTC');

    coin.getUnspents = jest.fn().mockResolvedValue([]);

    await expect(coin.createTransaction(RECIPIENT, 0.0005, 0.0001)).rejects.toThrow(/No unspent outputs/);
  });
});

describe('BtcBaseCoin.send', () => {
  /** @type {BtcCoin} */
  let coin;

  beforeEach(() => {
    coin = new BtcCoin('BTC');
    coin.getUnspents = jest.fn().mockResolvedValue([createFundingUtxo(coin.address, coin.account.network, 100000)]);
    coin.sendTransaction = jest.fn().mockResolvedValue('broadcast-txid');
  });

  test('builds, signs and broadcasts', async () => {
    await expect(coin.send({ address: RECIPIENT, value: 0.0005 })).resolves.toEqual({
      success: true,
      hash: 'broadcast-txid',
    });
    expect(coin.sendTransaction).toHaveBeenCalledTimes(1);
  });

  test('refuses to sign anything for an invalid address', async () => {
    const result = await coin.send({ address: 'not-an-address', value: 0.0005 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is not a valid BTC address/);
    expect(coin.getUnspents).not.toHaveBeenCalled();
    expect(coin.sendTransaction).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Refusing to send'));
  });

  test('reports a failed broadcast instead of claiming success', async () => {
    coin.sendTransaction.mockResolvedValue(undefined);

    const result = await coin.send({ address: RECIPIENT, value: 0.0005 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unable to broadcast/);
  });

  test('reports a build failure instead of throwing', async () => {
    coin.getUnspents.mockResolvedValue([]);

    const result = await coin.send({ address: RECIPIENT, value: 0.0005 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No unspent outputs/);
    expect(coin.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('BtcBaseCoin.mapTransaction', () => {
  const coin = new BtcCoin('BTC');

  const transfer = {
    txid: 'abc',
    blockhash: 'block-1',
    confirmations: 3,
    time: 1700000000,
    fees: 0.0001,
    height: 800000,
    vin: [{ address: 'sender-address', value: 1 }],
    vout: [
      { value: '0.4', scriptPubKey: { addresses: ['recipient-address'] } },
      { value: '0.5999', scriptPubKey: { addresses: ['sender-address'] } },
    ],
  };

  test('identifies the single sender and the single recipient, ignoring the change output', () => {
    const mapped = coin.mapTransaction(transfer);

    expect(mapped.senderId).toBe('sender-address');
    expect(mapped.recipientId).toBe('recipient-address');
    expect(mapped.amount).toBe(0.4);
  });

  test('reports the status, height, fee and timestamp', () => {
    const mapped = coin.mapTransaction(transfer);

    expect(mapped.status).toBe(true);
    expect(mapped.height).toBe(800000);
    expect(mapped.fee).toBe(0.0001);
    expect(mapped.timestamp).toBe(1700000000000);
    expect(mapped.confirmations).toBe(3);
  });

  test('leaves the status undefined while the transaction is unconfirmed', () => {
    expect(coin.mapTransaction({ ...transfer, confirmations: 0 }).status).toBeUndefined();
  });

  test('derives the fee from the inputs and outputs when the node does not report it', () => {
    const mapped = coin.mapTransaction({ ...transfer, fees: undefined });

    expect(mapped.fee).toBeCloseTo(0.0001, 8);
  });

  test('describes a multi-party transaction rather than guessing one sender', () => {
    const mapped = coin.mapTransaction({
      ...transfer,
      vin: [
        { address: 'a', value: 1 },
        { address: 'b', value: 1 },
      ],
    });

    expect(mapped.senderId).toBe('2 addresses');
  });

  test('survives outputs with no addresses instead of throwing', () => {
    const mapped = coin.mapTransaction({
      ...transfer,
      vout: [{ value: '0.4', scriptPubKey: {} }],
    });

    expect(mapped.recipientId).toBe('0 addresses');
    expect(mapped.amount).toBe(0);
  });

  test('returns the input unchanged when it cannot be mapped at all', () => {
    const broken = { txid: 'abc' };

    expect(coin.mapTransaction(broken)).toBe(broken);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Error while formatting Tx'));
  });
});

describe('BtcBaseCoin.formTxMessage', () => {
  const coin = new BtcCoin('BTC');

  test('names the bot as "Me" on whichever side it is', () => {
    const outgoing = coin.formTxMessage({
      hash: 'abc',
      amount: 0.5,
      senderId: coin.address,
      recipientId: RECIPIENT,
      status: true,
      height: 1,
      confirmations: 2,
      fee: 0.0001,
    });

    expect(outgoing).toContain('from Me to 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2');

    const incoming = coin.formTxMessage({ hash: 'abc', senderId: RECIPIENT, recipientId: coin.address });

    expect(incoming).toContain('to Me');
  });

  test('reports a failed transaction explicitly', () => {
    expect(coin.formTxMessage({ hash: 'abc', status: false })).toContain('has FAILED');
  });

  test('mentions an InstantSend lock when there is no height yet', () => {
    const message = coin.formTxMessage({
      hash: 'abc',
      instantlock: true,
      instantlock_internal: true,
    });

    expect(message).toContain('locked with InstantSend');
  });
});

describe('buildTransaction across the UTXO coins', () => {
  const DashCoin = require('../../helpers/cryptos/dash_utils');
  const DogeCoin = require('../../helpers/cryptos/doge_utils');

  // Dash and Dogecoin networks carry no `bech32` prefix, unlike Bitcoin's. PSBT and
  // `toOutputScript` must still work for their P2PKH addresses.
  test.each([
    ['BTC', () => new BtcCoin('BTC'), RECIPIENT],
    ['DASH', () => new DashCoin('DASH'), 'XqXB6kPmSK44aC9AtR72zqgXWjqL9fWgdL'],
    ['DOGE', () => new DogeCoin('DOGE'), 'DKyRokgWn1jkxFjBm7nNh5ALZXywSGWJYh'],
  ])('%s signs a transfer and keeps exactly its fee', (token, create, recipient) => {
    const coin = create();
    const funded = 100;
    const sent = 50;
    const utxo = createFundingUtxo(coin.address, coin.account.network, coin.toSat(funded));

    const hex = coin.buildTransaction(recipient, sent, [utxo], coin.FEE);
    const tx = bitcoin.Transaction.fromHex(hex);
    const outputs = decodeOutputs(hex, coin.account.network);

    expect(tx.ins).toHaveLength(1);
    expect(tx.ins[0].script.length).toBeGreaterThan(0);
    expect(outputs).toEqual([
      { address: recipient, value: coin.toSat(sent) },
      { address: coin.address, value: coin.toSat(funded - sent) - coin.toSat(coin.FEE) },
    ]);

    const paidToMiner = coin.toSat(funded) - outputs.reduce((sum, out) => sum + out.value, 0);

    expect(coin.fromSat(paidToMiner)).toBe(coin.FEE);
  });

  test.each([
    ['DASH', () => new DashCoin('DASH'), 'XqXB6kPmSK44aC9AtR72zqgXWjqL9fWgdL'],
    ['DOGE', () => new DogeCoin('DOGE'), 'DKyRokgWn1jkxFjBm7nNh5ALZXywSGWJYh'],
  ])('%s rejects a Bitcoin address', (token, create) => {
    const coin = create();
    const utxo = createFundingUtxo(coin.address, coin.account.network, coin.toSat(100));

    expect(coin.isValidAddress(RECIPIENT)).toBe(false);
    expect(() => coin.buildTransaction(RECIPIENT, 50, [utxo], coin.FEE)).toThrow();
  });
});
