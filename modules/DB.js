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
	collections.system = db.collection("systems");
	collections.incoming_txs = db.collection("incomingtxs");
});

module.exports = collections;
