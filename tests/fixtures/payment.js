/**
 * Builds a payment document that behaves like one loaded from MongoDB.
 *
 * `update` and `save` are jest mocks that also mutate the object, so a test can
 * both assert on the calls and read the resulting state.
 *
 * @param {object} [overrides] Fields to set on the payment
 * @returns {object} A payment stand-in
 */
function createPayment(overrides = {}) {
  const payment = {
    _id: 'adm-tx-1',
    admTxId: 'adm-tx-1',
    itxId: 'adm-tx-1',
    senderId: 'U16655734187932477074',
    inCurrency: 'ADM',
    outCurrency: 'BTC',
    inTxid: 'in-tx-1',
    inAmountMessage: 100,
    inAmountReal: 100,
    outAmount: 0.001,
    exchangePrice: 0.00001,
    senderKvsInAddress: 'U16655734187932477074',
    senderKvsOutAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
    isBasicChecksPassed: true,
    transactionIsValid: true,
    inTxConfirmed: true,
    isFinished: false,
    transactionIsFailed: false,
    needToSendBack: false,
    needHumanCheck: false,
    outTxid: null,
    sentBackTx: null,
    ...overrides,
  };

  payment.save = jest.fn().mockResolvedValue(payment._id);
  payment.update = jest.fn().mockImplementation(async (fields) => {
    Object.assign(payment, fields);
  });

  return payment;
}

module.exports = { createPayment };
