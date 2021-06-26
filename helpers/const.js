module.exports = {

	SAT: 100000000, // 1 ADM = 100000000
	EPOCH: Date.UTC(2017, 8, 2, 17, 0, 0, 0), // ADAMANT's epoch time
	FORMAT_TRANS: 'YYYY-MM-DD HH:mm',
	FORMAT_PAYOUT: 'YYYY-MM-DD',
	PRECISION_DECIMALS: 8, // Accuracy for converting cryptos, 9.12345678 ETH
	PRINT_DECIMALS: 8, // For pretty print, 9.12345678 ETH
	UPDATE_CRYPTO_RATES_INVERVAL: 60 * 1000 // Update crypto rates every minute

}