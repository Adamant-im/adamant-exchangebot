/**
 * Make sure 'sat' is in this ethUtils.unitMap structure: decimals is in [1, 3, 6, 9, 12, 15, 18, 21, 24, 27]
 * Other way, update erc20_utils.toSat()
 */
module.exports = {
  USDS: {
    decimals: 6,
    sc: '0xa4bdb11dc0a2bec88d24a3aa1e6bb17201112ebe',
    token: 'USDS',
  },
  BZ: {
    decimals: 18,
    sc: '0x4375e7ad8a01b8ec3ed041399f62d9cd120e0063',
    token: 'BZ',
  },
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
};
