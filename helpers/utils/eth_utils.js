const api = require('../../modules/api');
const {
	eth
} = api;

module.exports = {
	syncGetTransaction(hash) {
		return new Promise(resolve => {
			eth.getTransaction(hash, (err, tx) => {
				if (err) {
					resolve(null);
				} else {
					resolve({
						blockNumber: tx.blockNumber,
						hash: tx.hash,
						sender: tx.from,
						recipient: tx.to,
						amount: tx.value / 1000000000000000000
					});
				}
			});
		});
	},
	getTransactionStatus(hash) {
		return new Promise(resolve => {
			eth.getTransactionReceipt(hash, (err, tx) => {
				if (err) {
					resolve(null);
				} else {
					resolve({
						blockNumber: tx.blockNumber,
						status: tx.status
					});
				}
			});
		});
	},
	getLastBlockNumber() {
		return new Promise(resolve => {
			eth.getBlock('latest').then(block => {
				if (block) {
					resolve(block.number);
				} else {
					resolve(null);
				}
			});
		});
	}
};
