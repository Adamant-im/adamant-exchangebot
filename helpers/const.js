module.exports = {

	HOUR: 60 * 60 * 1000,
	SAT: 100000000, // 1 ADM = 100000000
	ADM_EXPLORER_URL: 'https://explorer.adamant.im',
	EPOCH: Date.UTC(2017, 8, 2, 17, 0, 0, 0), // ADAMANT's epoch time
	FORMAT_TRANS: 'YYYY-MM-DD HH:mm',
	FORMAT_PAYOUT: 'YYYY-MM-DD',
	PRECISION_DECIMALS: 8, // Accuracy for converting cryptos, 9.12345678 ETH
	PRINT_DECIMALS: 8, // For pretty print, 9.12345678 ETH
	TX_CHECKER_INTERVAL: 4 * 1000, // Check for new Txs every 4 seconds; additionally Exchanger receives new Txs instantly via socket
	UPDATE_CRYPTO_RATES_INVERVAL: 60 * 1000, // Update crypto rates every minute
	VALIDATOR_TX_INTERVAL: 20 * 1000, // Validate Txs every 20 sec in deepExchangeValidator
	VALIDATOR_GET_TX_RETRIES: 30, // Retries to get Tx in deepExchangeValidator. In 10 minutes Tx must appear in a blockchain, otherwise Exchanger will decline it.
	VALIDATOR_AMOUNT_DEVIATION: 0.001, // 0.1% can be a precision error
	VALIDATOR_TIMESTAMP_DEVIATION: 3 * 24 * this.HOUR, // Difference between ADAMANT's token transfer message and real Tx can be up to 3 days. Duplicate Txs are filtered additionally.
	CONFIRMATIONS_INTERVAL: 20 * 1000, // Update Tx confirmations every 20 sec in confirmationsCounter
	SENDER_TX_INTERVAL: 20 * 1000, // Validate Txs every 20 sec in sentTxChecker
	SENDER_GET_TX_RETRIES: 60, // Retries to get Tx in sentTxChecker. In 20 minutes Tx must appear in a blockchain, otherwise Exchanger will notify master and user to check it manually.
	SENDER_RESEND_ETH_RETRIES: 1, // Retries to re-send failed Tx in sentTxChecker. F. e., out of gas for Ethereum and ERC20 transactions. Other coins have no limit on re-tries.
	EXCHANGER_INTERVAL: 15 * 1000, // Send exchange Txs every 15 sec in exchangePayer
	SENDBACK_INTERVAL: 15 * 1000, // Send back Txs every 15 sec in sendBack
	SENDBACK_RETRIES: 50, // How many times to re-try sending a payment back in sendBack
	
	ERRORS: {
		UNABLE_TO_FETCH_TX: 10,
		WRONG_SENDER: 11,
		WRONG_RECIPIENT: 12,
		WRONG_AMOUNT: 13,
		WRONG_TIMESTAMP: 34,
		NO_IN_KVS_ADDRESS: 8,
		NO_OUT_KVS_ADDRESS: 9,
		TX_FAILED: 14,
		UNABLE_TO_FETCH_SENT_TX: 14,
		SENT_TX_FAILED: 21,

	}

}