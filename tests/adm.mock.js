const blocksMock = {
  'success': true,
  'nodeTimestamp': 141587120,
  'blocks': [
    {
      'id': '1897234339516484106',
      'version': 0,
      'timestamp': 141587115,
      'height': 26599672,
      'previousBlock': '10543264504304960125',
      'numberOfTransactions': 0,
      'totalAmount': 0,
      'totalFee': 0,
      'reward': 35000000,
      'payloadLength': 0,
      'payloadHash': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'generatorPublicKey': '2725823b97ef1c3b45ed1e7d5257bdefe806b2b191cb81d674bcde9d7d4a5d2b',
      'generatorId': 'U13258254545402966394',
      'blockSignature': '363ffd3f3972c087e5d7025bb8ac2e989b53080e6fe0ea04390338ef754ec5d1a6320c64e64dc336299f447f05aae338e3a91fcddc7530af22079952e896c803',
      'confirmations': 1,
      'totalForged': '35000000',
    },
  ],
};

const accountMock = {
  'success': true,
  'nodeTimestamp': 141757519,
  'account': {
    'address': 'U1931433379363253593',
    'unconfirmedBalance': '57100000',
    'balance': '2110200000',
    'publicKey': '5d73fbdb4ce6e68ce86ab0158a2f4c34ab55f51a7c671a34807373d4a7f0cdc3',
    'unconfirmedSignature': 0,
    'secondSignature': 0,
    'secondPublicKey': null,
    'multisignatures': [],
    'u_multisignatures': [],
  },
};

const transactionMock = {
  'success': true,
  'nodeTimestamp': 141760654,
  'data': {
    'transaction': {
      'id': '527809405193872227',
      'height': 26629778,
      'blockId': '13010017585126857907',
      'type': 0,
      'block_timestamp': 141739215,
      'timestamp': 141739201,
      'senderPublicKey': 'a58dfce6761823270047e231d88deee0624b72b5da571e02ffd83547b18d5f77',
      'senderId': 'U7731178332738854026',
      'recipientId': 'U981620366078223342',
      'recipientPublicKey': '1f2d26e46454ddc416e764d89081240af3849e8a5eacc442a129dbd43f08611f',
      'amount': 22818698660,
      'fee': 50000000,
      'signature': '4d46d906f5e7319d29d84e40fef9be8893401f46f5df33bfa176f1454dedca75f939e10db6576fef7d2c4ecc331507d14092f177295e10d55cf401477f465903',
      'signatures': [],
      'confirmations': 4244,
      'asset': {},
    },
  },
};

const sendTransactionMock = {
  'success': true,
  'nodeTimestamp': 141881170,
  'transaction': {
    'id': '4754637906762938323',
    'height': 26656293,
    'blockId': '12051155408569460475',
    'type': 8,
    'block_timestamp': 141880960,
    'timestamp': 141880956,
    'senderPublicKey': '5d73fbdb4ce6e68ce86ab0158a2f4c34ab55f51a7c671a34807373d4a7f0cdc3',
    'senderId': 'U1931433379363253593',
    'recipientId': 'U6818514812134343263',
    'recipientPublicKey': 'ee060a9d0f052ffdbb33dff88d964cb563216cf91ef5c13e21ebb86ab3778bd3',
    'amount': 153157216,
    'fee': 50000000,
    'signature': 'a5f625debaf3738091ac3aa8c77edd3e5051be6e46cb47a9fe19d6de4fa198d8cb20a06f634cd9a9e388045d0e64c6e1beb7b9e63260baa16190940a894a250a',
    'signatures': [],
    'confirmations': 39,
    'asset': {},
  },
};

const paymentMock = {
  success: true,
  nodeTimestamp: 141880956,
  transactionId: '4754637906762938323',
};

module.exports = {
  blocksMock,
  accountMock,
  transactionMock,
  paymentMock,
  sendTransactionMock,
};
