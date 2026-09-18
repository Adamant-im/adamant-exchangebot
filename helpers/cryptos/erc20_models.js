/**
 * ERC-20 tokens the bot can work with.
 *
 * `decimals` must match the token contract exactly: it is what converts between
 * the amount a user sees and the integer the contract moves, so a wrong value is
 * a payout that is wrong by orders of magnitude.
 *
 * Contract addresses are checksummed Ethereum mainnet addresses.
 *
 * @type {Readonly<Record<string, {decimals: number, sc: string, token: string}>>}
 */
module.exports = Object.freeze({
  BNB: {
    decimals: 18,
    sc: '0xB8c77482e45F1F44dE1745F52C74426C631bDD52',
    token: 'BNB',
  },
  USDT: {
    decimals: 6,
    sc: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    token: 'USDT',
  },
  USDC: {
    decimals: 6,
    sc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    token: 'USDC',
  },
  DAI: {
    decimals: 18,
    sc: '0x6b175474e89094c44da98b954eedeac495271d0f',
    token: 'DAI',
  },
  XCN: {
    decimals: 18,
    sc: '0xa2cd3d43c775978a96bdbf12d733d5a1ed94fb18',
    token: 'XCN',
  },
});
