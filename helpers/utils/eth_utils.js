const api = require('../../modules/api');
const {eth} = api;

module.exports = {
	syncGetTransaction(hash) {
		return new Promise(resolve => {
			eth.getTransaction(hash, (err, tx) => {
				if (err) {
					resolve(null);
				} else {
					resolve({
						hash: tx.hash,
						sender: tx.from.toLowerCase(),
						recipient: tx.to.toLowerCase(),
						amount: tx.value / 1000000000000000000
					});
				}
			});
		});
	}
};
