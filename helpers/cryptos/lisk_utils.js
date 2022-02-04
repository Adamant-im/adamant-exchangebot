const config = require('../../modules/configReader');
const log = require('../log');
// const utils = require('../utils');

const lskNode = config.node_LSK[0]; // TODO: health check
// const axios = require('axios');
log.info(lskNode);

const btcBaseCoin = require('./btcBaseCoin');
module.exports = class lskCoin extends btcBaseCoin {};


