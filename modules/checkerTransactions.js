const Storage = require('./Storage');
const api = require('./api');

function check() {
	const {lastHeight} = Storage;
	console.log({lastHeight});
	const lastBlock = api.get('uri', 'blocks').blocks[0];
	Storage.updateSystem('lastBlock', lastBlock);
}


module.exports = () => {
	setInterval(check, 4500);
};
