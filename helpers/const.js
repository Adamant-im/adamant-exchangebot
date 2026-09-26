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
  /**
   * How often the operator is reminded of a refund that keeps waiting for data it
   * cannot proceed without, such as an exchange rate or the network fee.
   */
  WAIT_REMINDER_INTERVAL: 6 * 60 * 60 * 1000,

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

  /**
   * KVS records read per address lookup, the maximum a node returns in one page.
   * The history is what shows since when the current address has been bound.
   */
  KVS_HISTORY_LIMIT: 100,

  /** How often coin mempools are checked for new transfers to the bot. */
  DEPOSIT_WATCH_INTERVAL: 5 * 1000,
  /** Maximum time startup or a scheduler tick waits for one coin watcher. */
  DEPOSIT_WATCH_POLL_TIMEOUT: 20 * 1000,
  /**
   * Maximum number of full Ethereum mempool changes parsed in one poll. Parsing is
   * local and cheap; measured bursts reach about 600 changes per 5-second poll.
   */
  DEPOSIT_WATCH_MAX_EVM_CHANGES: 20000,
  /**
   * Lower cap for nodes that return hashes only and need one lookup per hash. Lookups
   * are sent in JSON-RPC batches of {@link DEPOSIT_WATCH_EVM_FETCH_CONCURRENCY}.
   */
  DEPOSIT_WATCH_MAX_EVM_HASH_LOOKUPS: 1000,
  /** Transaction lookups sent together; ethers groups them into one batched request. */
  DEPOSIT_WATCH_EVM_FETCH_CONCURRENCY: 100,
  /** Claims remain open briefly so a competing ADAMANT message can be evaluated. */
  DEPOSIT_DISPUTE_WINDOW: 5 * 60 * 1000,
  /**
   * How long a deposit may wait for a competing claim to be resolved before it goes to
   * manual review. A claim is normally validated within minutes.
   */
  DEPOSIT_UNRESOLVED_CLAIM_TIMEOUT: 60 * 60 * 1000,
  /** KVS ownership must predate first-seen by this many confirmed ADAMANT blocks. */
  DEPOSIT_KVS_SAFETY_BLOCKS: 2,

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
    WRONG_ASSET: 36,
    UNSUPPORTED_COIN: 37,
    DEPOSIT_CLAIM_CONFLICT: 38,
    UNVERIFIED_DEPOSIT_OWNER: 39,
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
    // Dogecoin nodes reject outputs below 0.01 DOGE as dust; see DUST_THRESHOLD in doge_utils.js.
    [Cryptos.DOGE]: 0.01,
  },
};
