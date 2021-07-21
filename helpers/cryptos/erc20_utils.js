const log = require('../../helpers/log');
const utils = require('../utils');
const constants = require('../const');

const ethCoin = require('./eth_utils');
module.exports = class erc20coin extends ethCoin {

  constructor(token, etherInstance) {
    super(token)
    this.etherInstance = etherInstance;
    this.account.address = this.etherInstance.account.address;
  }

  getLastBlock() {
    return this.etherInstance.getLastBlock()
  }

  async getLastBlockHeight() {
    return this.etherInstance.getLastBlockHeight()
  }

  fromSat(satValue) {
    try {
      return satValue / this.erc20model.sat
    } catch (e) {
      log.warn(`Error while converting fromSat(${satValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  toSat(tokenValue) {
    try {
      return (tokenValue * this.erc20model.sat).toFixed(0)
    } catch (e) {
      log.warn(`Error while converting toSat(${tokenValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  get FEE() {
    return +(this.etherInstance.FEE * this.reliabilityCoefFromEth).toFixed(constants.PRECISION_DECIMALS)
  }

}
