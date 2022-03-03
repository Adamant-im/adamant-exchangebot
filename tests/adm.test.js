const MockAdapter = require('axios-mock-adapter');
const api = require('../modules/api');
const adm_utils = require('../helpers/cryptos/adm_utils');
const utils = require('../helpers/utils');
const {
  blocksMock,
  accountMock,
  transactionMock,
  paymentMock,
  sendTransactionMock,
} = require('./adm.mock');

let ADM = null;


beforeAll(async () => {
  const axiosMock = new MockAdapter(api.axios, { onNoMatch: 'passthrough' });
  axiosMock.onGet('https://endless.adamant.im/api/blocks').reply(200, blocksMock);
  axiosMock.onGet('https://endless.adamant.im/api/accounts').reply(200, accountMock);
  axiosMock.onGet('https://endless.adamant.im/api/transactions/get?id=527809405193872227').reply(200, transactionMock);
  axiosMock.onGet('https://endless.adamant.im/api/transactions/get?id=4754637906762938323').reply(200, sendTransactionMock);
  axiosMock.onPost('https://endless.adamant.im/api/transactions/process').reply(200, paymentMock);

  ADM = new adm_utils();
});


test('Should return last block height', async () => {
  const height = await ADM.getLastBlockHeight();
  expect(height).toBe(blocksMock.blocks[0].height);
});

test('Should return balance of account', async () => {
  const balance = await ADM.getBalance();
  expect(balance).toBe(utils.satsToADM(accountMock.account.balance));
});

test('Should return transaction', async () => {
  const txId = '527809405193872227';
  const transaction = await ADM.getTransaction(txId);
  expect(transaction).toStrictEqual({
    status: transactionMock.data.transaction.confirmations > 0 ? true : undefined,
    height: transactionMock.data.transaction.height,
    blockId: transactionMock.data.transaction.blockId,
    timestamp: utils.toTimestamp(transactionMock.data.transaction.timestamp),
    hash: transactionMock.data.transaction.id,
    senderId: transactionMock.data.transaction.senderId,
    recipientId: transactionMock.data.transaction.recipientId,
    confirmations: expect.any(Number),
    amount: utils.satsToADM(transactionMock.data.transaction.amount), // in ADM
    fee: utils.satsToADM(transactionMock.data.transaction.fee), // in ADM
  });
});

test('Send transaction', async () => {
  const params = {
    address: 'U6818514812134343263',
    value: 1.53157216,
    comment: 'Done! Thank you for business. Hope to see you again.',
  };
  const payment = await ADM.send(params);
  const tx = await ADM.getTransaction(payment.hash);
  expect(tx).toStrictEqual({
    status: true,
    height: 26656293,
    blockId: '12051155408569460475',
    timestamp: 1646252556000,
    hash: '4754637906762938323',
    senderId: 'U1931433379363253593',
    recipientId: 'U6818514812134343263',
    confirmations: expect.any(Number),
    amount: 1.53157216,
    fee: 0.5,
  });
});
