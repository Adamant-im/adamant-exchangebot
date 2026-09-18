const bitcoin = require('bitcoinjs-lib');

/**
 * Builds a previous transaction that pays a given address.
 *
 * PSBT needs the full previous transaction to sign a P2PKH input, so tests that
 * exercise transaction building need real, parseable hex rather than a stub.
 *
 * @param {string} address Address the output pays to
 * @param {object} network Network the address belongs to
 * @param {number} amountInSat Output value, in the coin's smallest unit
 * @returns {{txid: string, vout: number, amount: number, hex: string}} A spendable unspent output
 */
function createFundingUtxo(address, network, amountInSat) {
  const tx = new bitcoin.Transaction();

  tx.version = 1;
  // A coinbase-style input: its content does not matter, only that the output is real.
  tx.addInput(new Uint8Array(32), 0xffffffff);
  tx.addOutput(bitcoin.address.toOutputScript(address, network), BigInt(amountInSat));

  return { txid: tx.getId(), vout: 0, amount: amountInSat, hex: tx.toHex() };
}

/**
 * Decodes a raw transaction into the outputs it pays.
 *
 * @param {string} hex Raw transaction, as a hex string
 * @param {object} network Network to decode addresses with
 * @returns {Array<{address: string|undefined, value: number}>}
 */
function decodeOutputs(hex, network) {
  return bitcoin.Transaction.fromHex(hex).outs.map((out) => {
    let address;

    try {
      address = bitcoin.address.fromOutputScript(out.script, network);
    } catch {
      address = undefined;
    }

    return { address, value: Number(out.value) };
  });
}

module.exports = { createFundingUtxo, decodeOutputs };
