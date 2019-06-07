const MongoClient = require("mongodb").MongoClient;

const mongoClient = new MongoClient("mongodb://localhost:27017/", {
	useNewUrlParser: true
});
const model = require('../helpers/dbModel');

const collections = {};

mongoClient.connect((err, client) => {
	if (err) {
		throw (err);
	}
	const db = client.db("excahngesdb");
	collections.db = db;
	collections.systemDb = model(db.collection("systems"));
	collections.incomingTxsDb = model(db.collection("incomingtxs"));
	collections.paymentsDb = model(db.collection("payments"));
});

module.exports = collections;
