const request = require('request');
const config = require('../modules/configReader');
const log = require('./log');
const api = require('../modules/api');
const {
	adamant_notify,
	slack
} = config;


module.exports = (message, type) => {
	try {
		log[type](message.replace(/\*/g, '').replace(/_/g, ''));

		if (!slack && !adamant_notify) {
			return;
		}
		let color;
		switch (type) {
		case ('error'):
			color = '#36a64f';
			break;

		case ('warn'):
			color = '#FFFF00';
			break;

		case ('info'):
			color = '#00FF00';
			break;
		case ('log'):
			color = '#fffff';
			break;
		}

		const opts = {
			uri: slack,
			method: 'POST',
			json: true,
			body: {
				'attachments': [{
					'fallback': message,
					'color': color,
					'text': message,
					'mrkdwn_in': ['text']
				}]
			}
		};
		if (slack && slack.length > 5) {
			request(opts);
		}
		if (adamant_notify && adamant_notify.length > 5 && adamant_notify.startsWith('U') && config.passPhrase) {
			api.send(config.passPhrase, adamant_notify, `${type}| ${message.replace(/\*/g, '**')}`, 'message');
		}
	} catch (e) {
		log.error('Notifer error: ' + e);
	}
};
