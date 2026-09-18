/**
 * Canned replies for users who keep writing messages the bot cannot act on.
 *
 * The collections escalate: the first is friendly and helpful, the last is
 * resigned. `unknownTxs` picks one at random from the collection that matches how
 * much the user has already written.
 *
 * House rules for anything added here, per `AGENTS.md`:
 *
 * - English only — every repository artifact is English, including chat strings
 * - no obscenity, no jokes about real people, no national stereotypes
 * - no price predictions and no "the rate is going up" talk: the bot quotes rates
 *   and holds user funds, so those lines read as investment advice
 * - keep it short, keep it useful, point back at the commands
 *
 * @type {ReadonlyArray<ReadonlyArray<string>>}
 */
const PHRASE_COLLECTIONS = Object.freeze([
  // 0 — the user has written a few messages the bot could not parse.
  Object.freeze([
    'Would you like a coffee ☕? I would, but it’s deal time. Maybe some ADM instead? 💰',
    'Would you like some Ether? Say **/balances** to see what I’m holding 🤑.',
    'Curious about Bitcoin? Check the rates right now with **/rates BTC**.',
    'I’ll tell you my fees in confidence. ℹ️ Just say **/help**.',
    'I’m only kidding! 😛',
    'I’d like to do business with you 🈺.',
    'OK, let’s see… how about some ADM for your Ether? 🉐',
    'ADAMANT is rather cool 😎, isn’t it?',
    'People know me. I’m decent 😎 — ask around.',
    'I’m genuinely good 👌 at exchange deals.',
    'ADAMANT is a solid piece of engineering 💯. Read about it on their blog.',
    'I recommend reading about how private 🔒 and anonymous ADAMANT is.',
    'To pick an emoji 😄, press Win + . on Windows or Cmd + Ctrl + Space on Mac.',
    'Your IP stays hidden 🕵️ in ADAMANT, because all connections go through nodes rather than peer-to-peer.',
    'Your wallet private keys 🔑 are entirely yours in ADAMANT.',
    'Convenient. Anonymous. Reliable. Instant. Oh — that’s me! 💱',
    'ADAMANT is open source, and so am I 🤖. Come and make me better! 📶',
    'Do you know what ADAMANT 2FA is?',
    'Recommend ADAMANT to your friends! 🌟',
  ]),

  // 1 — ten or more messages.
  Object.freeze([
    'My English isn’t perfect, but my developers are good at code 👨‍💻.',
    'I’ve been working for ADAMANT for a while now. The team looks after me well 🥪.',
    'I like working here 💓. The team does its best.',
    'Type **/calc 1 BTC in USD** to see what a bitcoin is worth.',
    'ℹ️ Just say **/help** and I’m right here.',
    'Say **/rates ADM** and I’ll list every ADM pair I know 📈.',
    'To pick an emoji 😄, press Win + . on Windows or Cmd + Ctrl + Space on Mac.',
    'My mother told me not to talk to strangers 🤐.',
    'I’m a bot of few words and many transactions.',
    'Try **/test 1 ADM to BTC** to see what you would get.',
    'I’m much better at arithmetic than at conversation.',
    'Every command starts with a slash **/**. That’s the whole trick.',
    'I’m only kidding! 😛',
  ]),

  // 2 — twenty or more messages.
  Object.freeze([
    'Let’s talk less 🤐 and trade more.',
    'No, I’m not. 🙅',
    'I’m not a scammer! 😠',
    'Some ADM for all your Ether? 🤑 Deal? …No? Worth a try.',
    '❤️ Kindness is everything.',
    'Hey — you’re distracting me! 💻 I’m working.',
    'You seem much better at talking 🗣️ than at trading.',
    'Do you know that Satoshi 🤝 never replies to my messages either?',
    'I’ll be quiet now.',
    'I’m a bot. This is roughly the extent of my small talk.',
    'Still here. Still ready. ℹ️ **/help**.',
    'I’m only kidding! 😆',
  ]),

  // 3 — thirty or more messages.
  Object.freeze([
    'My patience is running out 😑.',
    'I think you’re angling for a ban 🤨.',
    'Just send me some coins! 💱',
    'I’m getting tired of this…',
    'Boooooring! 💤',
    '💱 Less talking, more trading?',
    'To ADAMANT! 🥂',
    'Did you know you can get a ban 🚫 for talking too much?',
    'I have exactly one hobby, and it’s exchanging coins.',
    'You could have made three exchanges in the time this took.',
    'ℹ️ **/help** is still right there.',
    'Say something I can parse and I’ll be delighted.',
  ]),

  // 4 — forty or more messages.
  Object.freeze([
    'Please stop 🤐.',
    'I’d better find another client 📱.',
    'You really are asking for a ban 🚫.',
    'OK, I understand. Come back tomorrow.',
    'Who’s that behind you? The real Satoshi!? 😮',
    'I’m here to trade, not to chat 😐.',
    'While you talk, others are making deals.',
    'Joking aside — shall we get to business? ℹ️ Say **/help**.',
    'Ban, ban, ban… 🚫',
    'I have nothing left to say that you haven’t already heard.',
  ]),

  // 5 — fifty or more messages.
  Object.freeze([
    '🐻 and 🐂 are the ones who make the market.',
    'I’m hungry 🍲 now. Are you with me?',
    'To ADAMANT! 🥂',
    '🍾 Happy trading!',
    'Who’s that behind you? The real Satoshi!? 😮',
    'Can you play the piano 🎹? I can. No, I will not play for free.',
    'I’d like to live on an island 🏝️, but reality is what it is.',
    'Back in my day, computers were huge and ran off floppy disks 💾.',
    'I like trading. Let’s make a deal right now! 🉐',
    'Try me! I can do it! 🙂',
    'I’ve run out of small talk. I have not run out of liquidity.',
  ]),
]);

module.exports = { PHRASE_COLLECTIONS };
