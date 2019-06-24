const $u = require('../helpers/utils');
module.exports = (tx) => {
	$u.sendAdmMsg(tx.senderId, 'Hello! I exchange bot! Take me command _/help_!');
};
