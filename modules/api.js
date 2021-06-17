const log = require('../helpers/log');
const config = require('./configReader');
module.exports = require('adamant-api')({ node: config.node_ADM, logLevel: config.log_level }, log);
