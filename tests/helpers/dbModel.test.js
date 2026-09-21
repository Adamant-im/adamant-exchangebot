const createModel = require('../../helpers/dbModel');

/**
 * Builds a stand-in for a MongoDB collection.
 *
 * The model is a thin wrapper, so the interesting behaviour is which driver calls it
 * makes and with what — not how MongoDB would answer them.
 *
 * @param {object} [overrides] Methods to replace
 * @returns {object} A fake collection made of jest mocks
 */
function createFakeCollection(overrides = {}) {
  const cursor = { toArray: jest.fn().mockResolvedValue([]) };

  return {
    cursor,
    find: jest.fn().mockReturnValue(cursor),
    findOne: jest.fn().mockResolvedValue(null),
    countDocuments: jest.fn().mockResolvedValue(0),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'generated-id' }),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    ...overrides,
  };
}

describe('dbModel', () => {
  test('exposes the underlying collection', () => {
    const collection = createFakeCollection();
    const Model = createModel(collection);

    expect(Model.db).toBe(collection);
  });

  test('find returns model instances and passes the query and options through', async () => {
    const collection = createFakeCollection();

    collection.cursor.toArray.mockResolvedValue([{ _id: '1', amount: 5 }]);

    const Model = createModel(collection);
    const query = { senderId: 'U1' };
    const options = { sort: { date: -1 } };
    const results = await Model.find(query, options);

    expect(collection.find).toHaveBeenCalledWith(query, options);
    expect(results).toHaveLength(1);
    expect(results[0]).toBeInstanceOf(Model);
    expect(results[0].amount).toBe(5);
  });

  test('findOne returns null rather than an empty model when nothing matches', async () => {
    const collection = createFakeCollection();
    const Model = createModel(collection);

    await expect(Model.findOne({ txid: 'missing' })).resolves.toBeNull();
  });

  test('findOne wraps a found document in a model', async () => {
    const collection = createFakeCollection({ findOne: jest.fn().mockResolvedValue({ _id: '1', isFinished: false }) });
    const Model = createModel(collection);
    const document = await Model.findOne({ _id: '1' });

    expect(document).toBeInstanceOf(Model);
    expect(document.isFinished).toBe(false);
  });

  test('countDocuments delegates to the collection', async () => {
    const collection = createFakeCollection({ countDocuments: jest.fn().mockResolvedValue(7) });
    const Model = createModel(collection);

    await expect(Model.countDocuments({ senderId: 'U1' })).resolves.toBe(7);
  });

  test('save inserts a new document and stores the generated id', async () => {
    const collection = createFakeCollection();
    const Model = createModel(collection);
    const document = new Model({ amount: 1 });

    const id = await document.save();

    expect(collection.insertOne).toHaveBeenCalledWith({ amount: 1 });
    expect(id).toBe('generated-id');
    expect(document._id).toBe('generated-id');
  });

  test('save upserts an existing document and never writes the immutable _id', async () => {
    const collection = createFakeCollection();
    const Model = createModel(collection);
    const document = new Model({ _id: 'tx-1', amount: 1 });

    await document.save();

    expect(collection.insertOne).not.toHaveBeenCalled();
    expect(collection.updateOne).toHaveBeenCalledWith({ _id: 'tx-1' }, { $set: { amount: 1 } }, { upsert: true });
  });

  test('save rejects when the write fails, so a lost write cannot look like success', async () => {
    const collection = createFakeCollection({ insertOne: jest.fn().mockRejectedValue(new Error('write failed')) });
    const Model = createModel(collection);

    await expect(new Model({ amount: 1 }).save()).rejects.toThrow('write failed');
  });

  test('update assigns fields without writing unless asked', async () => {
    const collection = createFakeCollection();
    const Model = createModel(collection);
    const document = new Model({ _id: 'tx-1' });

    await document.update({ isFinished: true });

    expect(document.isFinished).toBe(true);
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  test('update writes when asked', async () => {
    const collection = createFakeCollection();
    const Model = createModel(collection);
    const document = new Model({ _id: 'tx-1' });

    await document.update({ isFinished: true }, true);

    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'tx-1' },
      { $set: { isFinished: true } },
      { upsert: true },
    );
  });

  test('two models over different collections stay independent', async () => {
    const payments = createFakeCollection();
    const incoming = createFakeCollection();
    const Payments = createModel(payments);
    const Incoming = createModel(incoming);

    await new Payments({ _id: 'p1' }).save();

    expect(payments.updateOne).toHaveBeenCalled();
    expect(incoming.updateOne).not.toHaveBeenCalled();
    expect(Incoming.db).toBe(incoming);
  });
});
