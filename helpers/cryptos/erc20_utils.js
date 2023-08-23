const constants = require('../const');

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

  get FEE() {
    return +(this.etherInstance.FEE * this.reliabilityCoefFromEth).toFixed(constants.PRECISION_DECIMALS);
  }
};
