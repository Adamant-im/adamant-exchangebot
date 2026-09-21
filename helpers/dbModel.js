/**
 * Builds a minimal active-record model over a MongoDB collection.
 *
 * Documents are plain objects with a `_id`; the model adds `save()` and
 * `update()` so pipeline modules can carry a payment around and persist it
 * without assembling update operators by hand.
 *
 * Every method returns a promise and rejects on failure — a silently dropped
 * write would leave the bot's idea of an exchange out of sync with the
 * blockchain.
 *
 * @param {import('mongodb').Collection} collection Collection to wrap
 * @returns {typeof Model} A model class bound to the collection
 */
module.exports = (collection) => {
  return class Model {
    /**
     * @param {object} [data] Document fields to assign
     * @param {boolean} [isSave] Persist immediately; the returned promise is not awaited here,
     *   so prefer `await new Model(data).save()` when the write must complete first
     */
    constructor(data = {}, isSave) {
      Object.assign(this, data);

      if (isSave) {
        this.save();
      }
    }

    /**
     * The underlying MongoDB collection, for operations the model does not wrap.
     *
     * @returns {import('mongodb').Collection}
     */
    static get db() {
      return collection;
    }

    /**
     * Finds documents.
     *
     * @param {object} [query] MongoDB filter
     * @param {object} [options] Cursor options, for example `{ sort: { date: -1 }, limit: 10 }`
     * @returns {Promise<Model[]>}
     */
    static async find(query = {}, options = {}) {
      const documents = await collection.find(query, options).toArray();

      return documents.map((document) => new this(document));
    }

    /**
     * Finds a single document.
     *
     * @param {object} [query] MongoDB filter
     * @param {object} [options] Query options
     * @returns {Promise<Model|null>} The document, or `null` when nothing matches
     */
    static async findOne(query = {}, options = {}) {
      const document = await collection.findOne(query, options);

      return document ? new this(document) : null;
    }

    /**
     * Counts documents matching a filter.
     *
     * @param {object} [query] MongoDB filter
     * @returns {Promise<number>}
     */
    static countDocuments(query = {}) {
      return collection.countDocuments(query);
    }

    /**
     * Returns the document's persistable fields, without `_id`.
     *
     * `_id` is immutable in MongoDB, so including it in a `$set` makes the server
     * reject the whole update.
     *
     * @returns {object}
     */
    _data() {
      const data = {};

      for (const field of Object.keys(this)) {
        if (field !== '_id') {
          data[field] = this[field];
        }
      }

      return data;
    }

    /**
     * Assigns fields, optionally persisting them.
     *
     * @param {object} fields Fields to assign
     * @param {boolean} [isSave] Persist after assigning
     * @returns {Promise<void>}
     */
    async update(fields, isSave) {
      Object.assign(this, fields);

      if (isSave) {
        await this.save();
      }
    }

    /**
     * Persists the document.
     *
     * Documents are inserted with an explicit `_id` when the caller sets one, and
     * upserted afterwards, so re-saving the same payment never creates a duplicate.
     *
     * @returns {Promise<*>} The document's `_id`
     */
    async save() {
      if (this._id === undefined) {
        const result = await collection.insertOne(this._data());

        this._id = result.insertedId;

        return this._id;
      }

      await collection.updateOne({ _id: this._id }, { $set: this._data() }, { upsert: true });

      return this._id;
    }
  };
};
