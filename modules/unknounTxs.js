const $u = require('../helpers/utils');
const db = require('./DB');
const config = require('./configReader');

module.exports = async (tx, itx) => {
	const {incomingTxsDb} = db;
	incomingTxsDb.db
		.find({
			sender: tx.senderId,
			type: 'unknown',
			date: {$gt: ($u.unix() - 2 * 3600 * 1000)}, // last 2h
		}).sort({date: -1}).toArray((err, docs) => {
			const countMsgs = docs.length;
			let msg = '';
			if (countMsgs === 1) {
				msg = config.welcome_string;
			}
			else if (countMsgs === 2) {
				msg = 'OK. It seems you don’t speak English. Contact my master and ask me to learn your native language. But note, it will take some time because I am not a genius.';
			}
			else if (countMsgs === 3) {
				msg = 'Hm.. Contact not me, but my master. No, I don’t know how to reach him. ADAMANT is so much anonymous.';
			}
			else if (countMsgs === 4) {
				msg = 'I see.. You just wanna talk. I am not the best at talking.';
			}
			else if (countMsgs < 10) {
				msg = getRnd(0);
			}
			else if (countMsgs < 20) {
				msg = getRnd(1);
			}
			else if (countMsgs < 30) {
				msg = getRnd(2);
			}
			else if (countMsgs < 40) {
				msg = getRnd(3);
			}
			else {
				msg = getRnd(4);
			}
			console.log(msg);
			$u.sendAdmMsg(tx.senderId, msg);
			itx.update({isProcessed: true}, true);
		});

};

function getRnd(collectionNum){
	const phrases = collection[collectionNum];
	const num = +(Math.random() * 100 / (phrases.length - 1)).toFixed(0);
	return phrases[num];
}
const collection = [
	[
		'Do you wanna beer? I want to have it aslo, but now is the deal time. May be some ADAMANTs?',
		'Do you wanna Ethers? Say /balances to see if I have some.',
		'Aaaaghr..! Check out Bitcoin rates with /rates BTC command!',
		'I can tell you my exchange rates by secret. Just say /exchange.',
		'I am just kiddin!',
		'I’d like to work with you.',
		'Ok, let see.. What about 10 ADM for all your Ethers?',
		'ADAMANT is cool, isn’t it?',
		'People know me. Ask somebody to confirm.',
		'I am good at exchange deal.',
		'ADAMANT is good. Read about it on their Blog.',
		'I recommend you to read about how ADAMANT is private and anonymous.',
		'Recommend ADAMANT to your friends!',
		'If I were Satoshi, I’d rebuild Bitcoin on top of ADAMANT!'
	],
	[
		'Do you know what is ‘биток’?',
		'Yeah.. my English was born in cold Russian village. I know. But my masters are good in programming.',
		'I am working for ADAMANT for some time already. I have to admit guys feed me good.',
		'I love ADAMANT. The team is doing all the best.',
		'Да не барыга я! Зарабатываю как могу.',
		'London is a capital of Great Britain.',
		'My mama told not to talk with strangers.',
		'Are you a girl or a boy? I am comfortable with girls.',
		'Have you heard ADAMANT on Binance already? ..I am not.',
		'When Binance?',
		'No, no. It is not good.',
		'D’oh.',
		'I am just kiddin!',
		'Can with you that the not so?'
	],
	[
		'Talk less.',
		'Shut up..',
		'No, I am not.',
		'I am not a scammer!',
		'1 ADM for 10 Ethers! Deal! Buterin will understand soon who is the daddy.',
		'Гони бабло! ..sorry for my native.',
		'Это у вас навар адский. А у меня.. это комиссия за честную работу.',
		'Ландон из э капитал оф грейт брит.. блять, я перебрал..',
		'❤️ Love is everything.',
		'Hey.. You disturb me! I am working!',
		'It seems you are good in talking only.',
		'OK. I better call you now.',
		'I am not a motherf.. how do you know such words, little?',
		'Do you know Satoshi is my close friend?',
		'I am just kiddin!',
		'Can with you that the not so?'
	],
	[
		'My patience is over.',
		'You want ban I think.',
		'Just give me some money.',
		'I am tired of you..',
		'Booooooring!',
		'Stop talking, go working?',
		'Ща бы пивка и дернуть кого-нибудь.',
		'Да ну эту крипту! Пойдем гульнем лучше!',
		'Хорошо, что тып арускин епо немаишь гыгыггыгыггы',
		'Try to translate this: ‘На хера мне без хера, если с хером до хера!’',
		'Do you know you can get a ban for much talking?',
		'Can with you that the not so?',
		'I am just kiddin!'
	],
	[
		'I better find another client.',
		'You want to be banned for sure!',
		'Ok.. I understood. Come back tomorrow.',
		'Who is it behind you? A Satoshi!?',
		'Can with you that the not so?',
		'Do you know this code entry called ‘shit’? Check out in ADAMANT’s Github by yourself.',
		'Ban-ban-ban..',
		'УДОЛИЛ!!!!!!!!!1111111',
		'Some crazy guy taught me so much words to speak. Вот чо это за слово такое, таугхт? Ёпт.',
		'Пошутили и хватит. Давайте к делу? Скажите /help, чтобы получить справку.',
		'Ban-ban-ban..',
		'АСТАНАВИТЕСЬ!',
		'Ё и Е — разные буквы. Не путай, инглишь-спикер!'
	]
];
