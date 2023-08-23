const log = require('../../helpers/log');
const utils = require('../utils');
const constants = require('../const');
const ethUtils = require('web3-utils');

const ethCoin = require('./eth_utils');

module.exports = class erc20coin extends ethCoin {
  constructor(token, etherInstance) {
    super(token);
    this.etherInstance = etherInstance;
    this.account.address = this.etherInstance.account.address;
  }

  getLastBlock() {
    return this.etherInstance.getLastBlock();
  }

  async getLastBlockHeight() {
    return this.etherInstance.getLastBlockHeight();
  }

  fromSat(satValue) {
    try {
      return satValue / this.erc20model.sat;
    } catch (e) {
      log.warn(`Error while converting fromSat(${satValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  toSat(tokenValue) {
    try {
      const unitMap = ethUtils.unitMap;
      const unit = Object.keys(unitMap).find((k) => unitMap[k] === String(this.erc20model.sat));

      if (unit) {
        const amountInSat = ethUtils.toWei(String(tokenValue), unit);
        return amountInSat;
      } else {
        throw String(`No conversion unit found for ${this.token}, multiplier: ${this.erc20model.sat}. Check erc20_models.`);
      }
    } catch (e) {
      log.warn(`Error while converting toSat(${tokenValue}) for ${this.token} of ${utils.getModuleName(module.id)} module: ` + e);
    }
  }

  get FEE() {
    return +(this.etherInstance.FEE * this.reliabilityCoefFromEth).toFixed(constants.PRECISION_DECIMALS);
  }
};
