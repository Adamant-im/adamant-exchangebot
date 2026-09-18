/**
 * Tickers the bot knows how to work with.
 *
 * This is only a spelling reference for code that needs a literal ticker.
 * Which coins are actually accepted, exchanged or merely recognized is decided
 * by `accepted_crypto`, `exchange_crypto` and `known_crypto` in the config.
 *
 * @type {Readonly<Record<string, string>>}
 */
const Cryptos = Object.freeze({
  ADM: 'ADM',
  BTC: 'BTC',
  ETH: 'ETH',
  DOGE: 'DOGE',
  DASH: 'DASH',
  BNB: 'BNB',
  USDT: 'USDT',
  USDC: 'USDC',
  DAI: 'DAI',
  XCN: 'XCN',
});

module.exports = {
  Cryptos,

  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,

  SAT: 100000000, // 1 ADM = 100 000 000 sats
  ADM_EXPLORER_URL: 'https://explorer.adamant.im',
  /** Start of the ADAMANT epoch. Blockchain timestamps are counted in seconds from this moment. */
  ADM_EPOCH: Date.UTC(2017, 8, 2, 17, 0, 0, 0),

  PRECISION_DECIMALS: 8, // Accuracy for converting cryptos, 9.12345678 ETH
  PRINT_DECIMALS: 8, // For pretty printing, 9.12345678 ETH

  /** How often the REST poller asks for new ADM transactions. Sockets deliver them instantly as well. */
  TX_CHECKER_INTERVAL: 4 * 1000,
  /** How often exchange rates are refreshed from ADAMANT InfoService. */
  UPDATE_CRYPTO_RATES_INTERVAL: 60 * 1000,

  /** How often deepExchangeValidator re-checks payments that are not validated yet. */
  VALIDATOR_TX_INTERVAL: 20 * 1000,
  /**
   * How many times deepExchangeValidator retries fetching an incoming Tx.
   * At VALIDATOR_TX_INTERVAL this is 10 minutes; a Tx that never appears is declined.
   */
  VALIDATOR_GET_TX_RETRIES: 30,
  /** Relative deviation between the announced and the on-chain amount that is still considered a rounding error. */
  VALIDATOR_AMOUNT_DEVIATION: 0.001, // 0.1%
  /**
   * Allowed gap between the ADAMANT in-chat transfer message and the timestamp of the transfer
   * in its own blockchain. Duplicate Txs are filtered separately.
   */
  VALIDATOR_TIMESTAMP_DEVIATION: 3 * 24 * 60 * 60 * 1000, // 3 days

  /** How often confirmationsCounter refreshes confirmations of accepted incoming Txs. */
  CONFIRMATIONS_INTERVAL: 20 * 1000,

  /** How often sentTxChecker verifies Txs the bot has sent. */
  SENDER_TX_INTERVAL: 20 * 1000,
  /**
   * How many times sentTxChecker retries fetching a sent Tx.
   * At SENDER_TX_INTERVAL this is 20 minutes; after that the operator and the user are notified.
   */
  SENDER_GET_TX_RETRIES: 60,
  /**
   * How many times a failed Ethereum or ERC-20 payout is re-sent, for example after running out of gas.
   * Other coins are retried without this limit.
   */
  SENDER_RESEND_ETH_RETRIES: 1,

  /** How often exchangePayer sends out pending exchange payments. */
  EXCHANGER_INTERVAL: 10 * 1000,
  /** How many times exchangePayer retries a failed exchange payment. */
  EXCHANGER_RETRIES: 50,

  /** How often sendBack sends out pending refunds. */
  SENDBACK_INTERVAL: 15 * 1000,
  /** How many times sendBack retries a failed refund. */
  SENDBACK_RETRIES: 50,

  /**
   * Error codes stored with a payment. They end up in the database, so existing
   * values must not be reused for a different meaning.
   */
  ERRORS: {
    NO_IN_KVS_ADDRESS: 8,
    NO_OUT_KVS_ADDRESS: 9,
    UNABLE_TO_FETCH_TX: 10,
    WRONG_SENDER: 11,
    WRONG_RECIPIENT: 12,
    WRONG_AMOUNT: 13,
    TX_FAILED: 14,
    UNABLE_TO_FETCH_SENT_TX: 14,
    SENT_TX_FAILED: 21,
    WRONG_TIMESTAMP: 34,
    INVALID_PAYOUT_ADDRESS: 35,
  },

  /**
   * Transfers at or below these amounts are refused: some networks reject them as dust,
   * and for others the payout would leave the wallet unusable.
   *
   * @type {Record<string, number>}
   */
  minBalances: {
    [Cryptos.BTC]: 0.00001,
    [Cryptos.DASH]: 0.0001,
  },
};
