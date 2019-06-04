const MongoClient = require("mongodb").MongoClient;

const mongoClient = new MongoClient("mongodb://localhost:27017/", {
	useNewUrlParser: true
});

const collections = {};

mongoClient.connect((err, client) => {
	if (err) {
		throw (err);
	}
	const db = client.db("excahngesdb");
	collections.db = db;
	collections.systemDb = db.collection("systems");
	collections.incomingTxsDb = db.collection("incomingtxs");
	collections.paymentsDb = db.collection("payments");
});

module.exports = collections;
