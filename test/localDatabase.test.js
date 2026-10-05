const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateTestUri, dropTestDatabase } = require('./helpers/localDatabase')

test('test URI allows only the explicit local test database', () => {
  assert.match(validateTestUri(), /127\.0\.0\.1:27017\/executivecars_test/)
  assert.match(validateTestUri('mongodb://localhost:27017/executivecars_test'), /replicaSet=executivecars-local/)
  for (const uri of [
    'mongodb+srv://cluster.example.net/executivecars_test',
    'mongodb://example.net:27017/executivecars_test',
    'mongodb://127.0.0.1:27018/executivecars_test',
    'mongodb://127.0.0.1:27017/executivecars',
    'mongodb://127.0.0.1:27017/executivecars_dev',
    'mongodb://127.0.0.1:27017/executivecars_test_restore_local_20261005',
    'mongodb://127.0.0.1:27017/',
    'mongodb://name:password@127.0.0.1:27017/executivecars_test',
  ]) assert.throws(() => validateTestUri(uri), /only localhost/)
})

test('database drop refuses incorrect environment, database, host, port or replica state before mutation', async () => {
  const previous = process.env.NODE_ENV
  let drops = 0
  const connection = (changes = {}, hello = { setName: 'executivecars-local', isWritablePrimary: true }) => ({
    name: 'executivecars_test', host: '127.0.0.1', port: 27017,
    db: { admin: () => ({ command: async () => hello }), dropDatabase: async () => { drops++ } }, ...changes,
  })
  try {
    process.env.NODE_ENV = 'test'
    for (const changes of [{ name: 'executivecars_dev' }, { name: 'executivecars' }, { host: 'cluster.mongodb.net' }, { port: 27018 }]) {
      await assert.rejects(dropTestDatabase(connection(changes)), /Refusing/)
    }
    await assert.rejects(dropTestDatabase(connection({}, { setName: 'another-replica', isWritablePrimary: true })), /replica-set PRIMARY/)
    await assert.rejects(dropTestDatabase(connection({}, { setName: 'executivecars-local', isWritablePrimary: false })), /replica-set PRIMARY/)
    process.env.NODE_ENV = 'production'
    await assert.rejects(dropTestDatabase(connection()), /Refusing/)
    assert.equal(drops, 0)
    process.env.NODE_ENV = 'test'
    await dropTestDatabase(connection())
    assert.equal(drops, 1)
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})
