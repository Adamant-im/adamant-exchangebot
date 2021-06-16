const log = require('../helpers/log');
const MongoClient = require("mongodb").MongoClient;
const mongoClient = new MongoClient("mongodb://localhost:27017/", {useNewUrlParser: true, useUnifiedTopology: true});
const model = require('../helpers/dbModel');

const collections = {};

mongoClient.connect((error, client) => {

	if (error) {
		log.error(`Unable to connect to MongoBD, ` + error);
		process.exit(-1);
	}
	const db = client.db("exchangerdb");
	collections.db = db;
	collections.systemDb = model(db.collection("systems"));
	collections.incomingTxsDb = model(db.collection("incomingtxs"));
	collections.paymentsDb = model(db.collection("payments"));

});

module.exports = collections;
