const EthCoin = require('./eth_utils');

/**
 * ERC-20 token adapter.
 *
 * A token shares the Ethereum wallet, provider and gas price with the ETH adapter —
 * the only things that differ are the contract, the decimals, and the larger fee
 * margin a contract call needs.
 */
module.exports = class Erc20Coin extends EthCoin {
  /**
   * @param {string} token Token symbol, which must exist in `erc20_models.js`
   * @param {EthCoin} ethInstance The ETH adapter to share the wallet and provider with
   */
  constructor(token, ethInstance) {
    super(token, ethInstance);
  }
};
