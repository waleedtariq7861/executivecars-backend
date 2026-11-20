process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) process.env[key] = ''

const test = require('node:test')
const assert = require('node:assert/strict')
const { cloudinary } = require('../src/config/cloudinary')
const { openCloudinaryDocument } = require('../src/services/cloudinaryDocument')

const asset = { key: 'executive-cars/reports/abc123', resourceType: 'raw', extension: '.pdf' }
const bytes = Buffer.from('%PDF-1.4\nsynthetic cloudinary fixture\n%%EOF')
const SIGNED_URL = 'https://cloudinary.test/signed?sig=secret'

const mockStorage = (t, respond) => ({
  sign: t.mock.method(cloudinary.utils, 'private_download_url', () => SIGNED_URL),
  fetch: t.mock.method(globalThis, 'fetch', respond),
})
const readAll = async stream => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('the report is fetched with a signed server-side link and handed back as a stream', async t => {
  const mocks = mockStorage(t, async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }))
  const opened = await openCloudinaryDocument(asset)
  assert.equal(opened.contentLength, bytes.length)
  assert.deepEqual(await readAll(opened.stream), bytes)

  const [key, format, options] = mocks.sign.mock.calls[0].arguments
  assert.equal(key, asset.key)
  assert.equal(format, 'pdf', 'the stored extension without its dot')
  assert.equal(options.resource_type, 'raw')
  assert.equal(options.type, 'authenticated')
  assert.equal(typeof options.expires_at, 'number')

  const [url, fetchOptions] = mocks.fetch.mock.calls[0].arguments
  assert.equal(url, SIGNED_URL)
  assert.ok(fetchOptions.signal instanceof AbortSignal, 'a timeout is attached to the request')
})

test('a storage that never answers is cut off after the timeout with a 502', { timeout: 3000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  mockStorage(t, (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason))
  }))
  const pending = openCloudinaryDocument(asset)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(15000)
  await assert.rejects(pending, error => error.status === 502)
})

test('the timeout only covers the wait for the answer, never a slow download', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mocks = mockStorage(t, async () => new Response(bytes, { status: 200 }))
  const opened = await openCloudinaryDocument(asset)
  t.mock.timers.tick(60000)
  assert.equal(mocks.fetch.mock.calls[0].arguments[1].signal.aborted, false)
  assert.deepEqual(await readAll(opened.stream), bytes)
})

test('a compressed answer carries no length, because the stream we send is the decoded one', async t => {
  mockStorage(t, async () => new Response(bytes, { status: 200, headers: { 'content-encoding': 'gzip', 'content-length': '5' } }))
  const opened = await openCloudinaryDocument(asset)
  assert.equal(opened.contentLength, null)
  await readAll(opened.stream)
})

test('a storage that stalls before the first byte is cut off with a 502, not left hanging', { timeout: 3000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  mockStorage(t, async (url, options) => new Response(new ReadableStream({
    start(controller) { options.signal.addEventListener('abort', () => controller.error(options.signal.reason)) },
  }), { status: 200 }))
  const pending = openCloudinaryDocument(asset)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(15000)
  await assert.rejects(pending, error => error.status === 502)
})

test('a storage that breaks before the first byte is a 502 the caller can still answer', async t => {
  mockStorage(t, async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')) } }), { status: 200 }))
  await assert.rejects(openCloudinaryDocument(asset), error => error.status === 502)
})

test('a report that arrives in several pieces is handed on whole', async t => {
  const first = bytes.subarray(0, 10)
  const rest = bytes.subarray(10)
  mockStorage(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(first); controller.enqueue(rest); controller.close() },
  }), { status: 200, headers: { 'content-length': String(bytes.length) } }))
  const opened = await openCloudinaryDocument(asset)
  assert.deepEqual(await readAll(opened.stream), bytes)
})

test('the caller can stop the fetch, for example when the browser has left', { timeout: 3000 }, async t => {
  mockStorage(t, (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason))
  }))
  const gone = new AbortController()
  const pending = openCloudinaryDocument(asset, { signal: gone.signal })
  await new Promise(resolve => setImmediate(resolve))
  gone.abort()
  await assert.rejects(pending, error => error.status === 502)
})

test('the unused body of an error answer is released', async t => {
  let released = 0
  const failing = status => async () => new Response(new ReadableStream({ cancel() { released += 1 } }), { status })
  mockStorage(t, failing(404))
  await assert.rejects(openCloudinaryDocument(asset), error => error.status === 404)
  t.mock.restoreAll()
  mockStorage(t, failing(500))
  await assert.rejects(openCloudinaryDocument(asset), error => error.status === 502)
  assert.equal(released, 2)
})

// The tests above replace fetch. These two use the real fetch against a real local HTTP server.
const withStorage = async (t, handler) => {
  const server = require('http').createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  t.mock.method(cloudinary.utils, 'private_download_url', () => `http://127.0.0.1:${server.address().port}/report`)
  return server
}

test('a report sent in two pieces by a real server arrives whole through real fetch', async t => {
  await withStorage(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) })
    res.write(bytes.subarray(0, 12))
    setTimeout(() => res.end(bytes.subarray(12)), 40)
  })
  const opened = await openCloudinaryDocument(asset)
  assert.equal(opened.contentLength, bytes.length)
  assert.deepEqual(await readAll(opened.stream), bytes)
})

test('destroying the stream closes the connection to a real server', async t => {
  let closed
  const connectionClosed = new Promise(resolve => { closed = resolve })
  await withStorage(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.write(bytes.subarray(0, 12))
    res.on('close', closed)
  })
  const opened = await openCloudinaryDocument(asset)
  opened.stream.destroy()
  await Promise.race([connectionClosed, new Promise((resolve, reject) => setTimeout(() => reject(new Error('connection stayed open')), 2000))])
})

test('a missing file is reported as 404', async t => {
  mockStorage(t, async () => new Response('not found', { status: 404 }))
  await assert.rejects(openCloudinaryDocument(asset), error => error.status === 404)
})

test('any other storage failure is reported as 502 without a hang', async t => {
  mockStorage(t, async () => new Response('boom', { status: 500 }))
  await assert.rejects(openCloudinaryDocument(asset), error => error.status === 502 && /not reachable/i.test(error.message))
  t.mock.restoreAll()
  mockStorage(t, async () => { throw new TypeError('fetch failed') })
  await assert.rejects(openCloudinaryDocument(asset), error => error.status === 502)
})
