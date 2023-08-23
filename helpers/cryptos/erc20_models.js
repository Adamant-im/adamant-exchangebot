/**
 * Make sure 'sat' is in this ethUtils.unitMap structure
 * Other way, update erc20_utils.toSat()
  {
    noether: '0',
    wei: '1',
    kwei: '1000',
    Kwei: '1000',
    babbage: '1000',
    femtoether: '1000',
    mwei: '1000000',
    Mwei: '1000000',
    lovelace: '1000000',
    picoether: '1000000',
    gwei: '1000000000',
    Gwei: '1000000000',
    shannon: '1000000000',
    nanoether: '1000000000',
    nano: '1000000000',
    szabo: '1000000000000',
    microether: '1000000000000',
    micro: '1000000000000',
    finney: '1000000000000000',
    milliether: '1000000000000000',
    milli: '1000000000000000',
    ether: '1000000000000000000',
    kether: '1000000000000000000000',
    grand: '1000000000000000000000',
    mether: '1000000000000000000000000',
    gether: '1000000000000000000000000000',
    tether: '1000000000000000000000000000000'
  }
 */

module.exports = {
  USDS: {
    sat: 1000000, // 6 decimals
    sc: '0xa4bdb11dc0a2bec88d24a3aa1e6bb17201112ebe',
    token: 'USDS',
  },
  BZ: {
    sat: 1000000000000000000, // 18 decimals
    sc: '0x4375e7ad8a01b8ec3ed041399f62d9cd120e0063',
    token: 'BZ',
  },
  BNB: {
    sat: 1000000000000000000, // 18 decimals
    sc: '0xB8c77482e45F1F44dE1745F52C74426C631bDD52',
    token: 'BNB',
  },
  USDT: {
    sat: 1000000, // 6 decimals
    sc: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    token: 'USDT',
  },
  USDC: {
    sat: 1000000, // 6 decimals
    sc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    token: 'USDC',
  },
  DAI: {
    sat: 1000000000000000000, // 18 decimals
    sc: '0x6b175474e89094c44da98b954eedeac495271d0f',
    token: 'DAI',
  },
  XCN: {
    sat: 1000000000000000000, // 18 decimals
    sc: '0xa2cd3d43c775978a96bdbf12d733d5a1ed94fb18',
    token: 'XCN',
  },
};
