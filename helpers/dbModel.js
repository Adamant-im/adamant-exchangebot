module.exports = (db) => {
	return class {
		constructor(data = {}) {
			this.db = db;
			Object.assign(this, data);
		}
		static get db() {
			return db;
		}
		static find(a, b, c) { // return Array
			db.find(a, b, c);
		}
		static findOne(a) {
			return new Promise((resolve, reject) => {
				db.findOne(a).then((doc, b) => {
					if (!doc) {
						resolve(doc);
					} else {
						resolve(new this(doc));
					}
				});
			});
		}
		_data() {
			const data = {};
			for (let field in this){
				if (!['db', '_id'].includes(field)){
					data[field] = this[field];
				}
			}
			return data;
		}
		async update(obj, isSave){
			Object.assign(this, obj);
			if (isSave){
				await this.save();
			}
		}
		save() {
			return new Promise((resolve, reject) => {
				if (!this._id) {
					db.insertOne(this._data(), (err, res) => {
						this._id = res.insertedId;
						resolve(this._id);
					});
				} else {
					db.updateOne({_id: this._id}, {
						$set: this._data()
					}, {upsert: true}).then(() => {
						resolve(this._id);
					});
				}
			});
		}
	};
};