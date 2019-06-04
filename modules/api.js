const config = require('./configReader');
module.exports = require('adamant-api')({passPhrase: config.passPhrase, node: config.node_ADM || config.node});
