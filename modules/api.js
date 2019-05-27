const config = require('./configReader');
module.exports = require('adamant-api')(config.node_ADM);
