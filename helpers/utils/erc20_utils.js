const Store = require('../../modules/Store');
const log = require('../../helpers/log');
const models = require('./erc20_models');
const config = require('./../../modules/configReader');
const eth = require('./eth_utils');
const $u = require('./index');

class erc20{
	constructor(token){
		this.token = token;
		this.model = models[token];
		this.User = Store.user[token] = JSON.parse(JSON.stringify(Store.user.ETH));
		this.address = this.User.address;
		const {web3} = Store;
		this.web3 = web3;
		this.contract = web3.eth.Contract(abiArray, this.model.sc, {from: this.User.address});
		$u[token] = this;
		console.log('Create ERC20:', token);
		this.updateBalance();
	}
	async updateBalance() {
		try {
			this.User.balance = ((await this.contract.methods.balanceOf(this.User.address).call()) || 0) / this.model.sat;
		} catch (e){
			log.error('Update ' + this.token + ' balance ' + e);
		}
	}
	async send(params) {
		const transfer = {
			address: this.model.sc,
			data: this.contract.methods.transfer(params.address, +(params.value * this.model.sat).toFixed(0)).encodeABI()
		};
		return await eth.send(params, transfer);
	}

	async getLastBlockNumber() {
		return await eth.getLastBlockNumber();
	}

	async syncGetTransaction(hash) {
		return new Promise(resolve =>{
			this.web3.eth.getTransactionReceipt(hash, (err, tx) => {
				try {
					if (err || !tx.logs) {
						resolve(false);
						return;
					}
					const info = tx.logs[0];
					resolve({
						blockNumber: tx.blockNumber,
						hash: hash,
						sender: tx.from,
						recipient: info.topics[2].replace('000000000000000000000000', ''),
						contract: tx.to,
						amount: +info.data / this.model.sat
					});
				} catch (e) {
					resolve(false);
				}
			});
		});
	}
	
	async getTransactionStatus(txid){
		return await eth.getTransactionStatus(txid);
	}

	get FEE() {
		const feeERC20 = eth.FEE * Store.mathEqual('ETH', this.token, 1, true).exchangePrice * 2;
		return 0; // TODO: fee@!
	}
}

const abiArray = [{
	'constant': true,
	'inputs': [],
	'name': 'name',
	'outputs': [{
		'name': '',
		'type': 'string'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': false,
	'inputs': [{
		'name': '_spender',
		'type': 'address'
	}, {
		'name': '_value',
		'type': 'uint256'
	}],
	'name': 'approve',
	'outputs': [{
		'name': '',
		'type': 'bool'
	}],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [],
	'name': 'totalSupply',
	'outputs': [{
		'name': '',
		'type': 'uint256'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': false,
	'inputs': [{
		'name': '_from',
		'type': 'address'
	}, {
		'name': '_to',
		'type': 'address'
	}, {
		'name': '_value',
		'type': 'uint256'
	}],
	'name': 'transferFrom',
	'outputs': [{
		'name': '',
		'type': 'bool'
	}],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [],
	'name': 'INITIAL_SUPPLY',
	'outputs': [{
		'name': '',
		'type': 'uint256'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [],
	'name': 'decimals',
	'outputs': [{
		'name': '',
		'type': 'uint8'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': false,
	'inputs': [{
		'name': '_spender',
		'type': 'address'
	}, {
		'name': '_subtractedValue',
		'type': 'uint256'
	}],
	'name': 'decreaseApproval',
	'outputs': [{
		'name': '',
		'type': 'bool'
	}],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [{
		'name': '_owner',
		'type': 'address'
	}],
	'name': 'balanceOf',
	'outputs': [{
		'name': 'balance',
		'type': 'uint256'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [],
	'name': 'symbol',
	'outputs': [{
		'name': '',
		'type': 'string'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'constant': false,
	'inputs': [{
		'name': '_to',
		'type': 'address'
	}, {
		'name': '_value',
		'type': 'uint256'
	}],
	'name': 'transfer',
	'outputs': [{
		'name': '',
		'type': 'bool'
	}],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'function'
}, {
	'constant': false,
	'inputs': [{
		'name': '_spender',
		'type': 'address'
	}, {
		'name': '_addedValue',
		'type': 'uint256'
	}],
	'name': 'increaseApproval',
	'outputs': [{
		'name': '',
		'type': 'bool'
	}],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'function'
}, {
	'constant': true,
	'inputs': [{
		'name': '_owner',
		'type': 'address'
	}, {
		'name': '_spender',
		'type': 'address'
	}],
	'name': 'allowance',
	'outputs': [{
		'name': '',
		'type': 'uint256'
	}],
	'payable': false,
	'stateMutability': 'view',
	'type': 'function'
}, {
	'inputs': [],
	'payable': false,
	'stateMutability': 'nonpayable',
	'type': 'constructor'
}, {
	'anonymous': false,
	'inputs': [{
		'indexed': true,
		'name': 'owner',
		'type': 'address'
	}, {
		'indexed': true,
		'name': 'spender',
		'type': 'address'
	}, {
		'indexed': false,
		'name': 'value',
		'type': 'uint256'
	}],
	'name': 'Approval',
	'type': 'event'
}, {
	'anonymous': false,
	'inputs': [{
		'indexed': true,
		'name': 'from',
		'type': 'address'
	}, {
		'indexed': true,
		'name': 'to',
		'type': 'address'
	}, {
		'indexed': false,
		'name': 'value',
		'type': 'uint256'
	}],
	'name': 'Transfer',
	'type': 'event'
}];
config.erc20.forEach(async t=>{ // create utills ERC20
	new erc20(t);
});
