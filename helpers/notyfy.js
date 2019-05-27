const log = require('./log');
module.exports = (msg, type) => { // TODO: добавить слаку, адамант и тд
	log[type](msg);
};
