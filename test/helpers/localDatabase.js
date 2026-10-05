const mongoose = require('mongoose')

const TEST_DATABASE = 'executivecars_test'
const REPLICA_SET = 'executivecars-local'
const DEFAULT_TEST_URI = `mongodb://127.0.0.1:27017/${TEST_DATABASE}?directConnection=true&replicaSet=${REPLICA_SET}`

const validateTestUri = (value = DEFAULT_TEST_URI) => {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('Tests require a valid local MongoDB URI') }
  if (parsed.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
    || (parsed.port && parsed.port !== '27017') || parsed.pathname !== `/${TEST_DATABASE}`
    || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Tests may use only localhost:27017/executivecars_test; Atlas, dev and restore databases are refused')
  }
  parsed.port = '27017'
  parsed.searchParams.set('directConnection', 'true')
  parsed.searchParams.set('replicaSet', REPLICA_SET)
  return parsed.toString()
}

const verifyTestDatabase = async (connection = mongoose.connection) => {
  if (process.env.NODE_ENV !== 'test' || connection.name !== TEST_DATABASE
    || !['127.0.0.1', 'localhost'].includes(connection.host) || connection.port !== 27017) {
    throw new Error('Refusing test database reset outside the explicit local test target')
  }
  const hello = await connection.db.admin().command({ hello: 1 })
  if (hello.setName !== REPLICA_SET || hello.isWritablePrimary !== true) {
    throw new Error('Tests require the executivecars-local replica-set PRIMARY')
  }
}

const connectTestDatabase = async () => {
  const uri = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
  // Models must not create collections/indexes before the live target guard.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoCreate: false, autoIndex: false })
  try { await verifyTestDatabase() } catch (error) { await mongoose.disconnect(); throw error }
}

const dropTestDatabase = async (connection = mongoose.connection) => {
  await verifyTestDatabase(connection)
  await connection.db.dropDatabase()
}

const resetTestDatabase = async () => {
  await dropTestDatabase()
  // Recreate actual model indexes for every test, including unique email indexes.
  for (const Model of Object.values(mongoose.models)) {
    await Model.createCollection()
    await Model.createIndexes()
  }
}

module.exports = { TEST_DATABASE, REPLICA_SET, DEFAULT_TEST_URI, validateTestUri, verifyTestDatabase, connectTestDatabase, dropTestDatabase, resetTestDatabase }
