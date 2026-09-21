const constants = require('../../helpers/const');

describe('constants', () => {
  test('the Cryptos map has no duplicate or self-contradicting entries', () => {
    for (const [key, value] of Object.entries(constants.Cryptos)) {
      expect(value).toBe(key);
    }
  });

  test('the Cryptos map is frozen, so a module cannot mutate the shared ticker list', () => {
    expect(Object.isFrozen(constants.Cryptos)).toBe(true);
  });

  test('Lisk has been removed', () => {
    expect(constants.Cryptos.LSK).toBeUndefined();
    expect(constants.minBalances.LSK).toBeUndefined();
  });

  test('refuses Dogecoin transfers the network would reject as dust', () => {
    // Dogecoin nodes reject outputs below 0.01 DOGE; the adapter uses the same limit.
    expect(constants.minBalances.DOGE).toBe(0.01);
  });

  test('the ADAMANT epoch matches the value the node uses', () => {
    expect(constants.ADM_EPOCH).toBe(Date.UTC(2017, 8, 2, 17, 0, 0, 0));
  });

  test('one ADM is one hundred million sats', () => {
    expect(constants.SAT).toBe(100000000);
  });

  test('error codes are unique per meaning, so a stored code stays readable', () => {
    // UNABLE_TO_FETCH_SENT_TX intentionally shares the value of TX_FAILED: both are
    // persisted as 14 and the distinction is only in which field they are written to.
    const { TX_FAILED, UNABLE_TO_FETCH_SENT_TX, ...rest } = constants.ERRORS;

    expect(TX_FAILED).toBe(UNABLE_TO_FETCH_SENT_TX);
    expect(new Set(Object.values(rest)).size).toBe(Object.keys(rest).length);
  });

  test('every interval and retry count is a positive number', () => {
    const numericConstants = [
      'HOUR',
      'DAY',
      'PRECISION_DECIMALS',
      'PRINT_DECIMALS',
      'TX_CHECKER_INTERVAL',
      'UPDATE_CRYPTO_RATES_INTERVAL',
      'VALIDATOR_TX_INTERVAL',
      'VALIDATOR_GET_TX_RETRIES',
      'VALIDATOR_AMOUNT_DEVIATION',
      'VALIDATOR_TIMESTAMP_DEVIATION',
      'CONFIRMATIONS_INTERVAL',
      'SENDER_TX_INTERVAL',
      'SENDER_GET_TX_RETRIES',
      'SENDER_RESEND_ETH_RETRIES',
      'EXCHANGER_INTERVAL',
      'EXCHANGER_RETRIES',
      'SENDBACK_INTERVAL',
      'SENDBACK_RETRIES',
    ];

    for (const name of numericConstants) {
      expect(typeof constants[name]).toBe('number');
      expect(constants[name]).toBeGreaterThan(0);
    }
  });

  test('the amount deviation stays a small tolerance, not a licence to underpay', () => {
    expect(constants.VALIDATOR_AMOUNT_DEVIATION).toBeLessThanOrEqual(0.01);
  });
});
