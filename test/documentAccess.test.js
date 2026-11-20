process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'development'
const { DEFAULT_TEST_URI, validateTestUri, connectTestDatabase, dropTestDatabase, resetTestDatabase } = require('./helpers/localDatabase')
process.env.MONGO_URI = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
// A local .env must never switch these tests to real Cloudinary or other integrations.
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GROQ_API_KEY', 'ML_SERVICE_KEY', 'RESEND_API_KEY']) process.env[key] = ''

const { before, after, beforeEach, test } = require('node:test')
const assert = require('node:assert/strict')
const mongoose = require('mongoose')
const fs = require('fs/promises')
const path = require('path')
require('./helpers/noRateLimits')
const request = require('supertest')
require('./helpers/cookieAuth')
const { createApp } = require('../server/app')
const Product = require('../src/models/Product')
const Car = require('../src/models/Car')
const Booking = require('../src/models/Booking')
const Member = require('../src/models/Member')
const { privateUploadDir } = require('../src/config/cloudinary')
// Customers created here are treated as verified; email verification has its own suite.
Member.prototype.isEmailVerified = () => true
const { Readable } = require('stream')
const { hmac } = require('../src/utils/crypto')
const { documentLimiter } = require('../src/middleware/rateLimits')
const { accessDocument } = require('../src/controllers/documentController')
const documentRouter = require('../src/routes/documents')

let app
before(async () => { await connectTestDatabase(); app = createApp() })
after(async () => {
  if (mongoose.connection.readyState === 1) {
    try { await dropTestDatabase() } finally { await mongoose.disconnect() }
  }
})
beforeEach(async () => { await resetTestDatabase() })

const bytes = Buffer.from('%PDF-1.4\nsynthetic document access fixture\n%%EOF')
const localAsset = key => ({ provider: 'local', key, resourceType: 'raw', contentType: 'application/pdf', size: bytes.length, extension: '.pdf' })

async function activeMember(email, phone) {
  const registration = await request(app).post('/api/auth/register').send({ name: 'Document Reader', email, phone, password: 'test-pass-123' })
  assert.equal(registration.status, 201)
  await Member.findByIdAndUpdate(registration.body.user.id, { subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 86400000) })
  return { id: registration.body.user.id, auth: { Authorization: `Bearer ${registration.body.token}` } }
}

async function withLocalPdf(run) {
  const key = `document-access-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`
  await fs.mkdir(privateUploadDir, { recursive: true })
  await fs.writeFile(path.join(privateUploadDir, key), bytes)
  try { await run(localAsset(key)) } finally { await fs.unlink(path.join(privateUploadDir, key)).catch(() => {}) }
}

const openLink = async access => request(app).get(new URL(access.body.url).pathname)

test('a used-car report opens inline as a PDF named after the car', async () => {
  await withLocalPdf(async asset => {
    const member = await activeMember('doc-product@example.com', '+92 300 4440001')
    const product = await Product.create({ make: 'Honda', model: 'City', year: 2022, km: 21000, price: 5200000, ownerId: member.id, inspectionDocument: asset })
    const access = await request(app).get(`/api/documents/products/${product._id}/report`).set(member.auth)
    assert.equal(access.status, 200)
    const document = await openLink(access)
    assert.equal(document.status, 200)
    assert.equal(document.headers['content-type'], 'application/pdf')
    assert.equal(document.headers['content-disposition'], 'inline; filename="Honda-City-2022-inspection-report.pdf"')
    assert.match(document.headers['cache-control'], /no-store/)
    assert.deepEqual(document.body, bytes)
  })
})

test('the link itself ends in the file name so a browser viewer shows and saves that name', async () => {
  await withLocalPdf(async asset => {
    const member = await activeMember('doc-linkname@example.com', '+92 300 4440005')
    const product = await Product.create({ make: 'Honda', model: 'City', year: 2022, km: 21000, price: 5200000, ownerId: member.id, inspectionDocument: asset })
    const access = await request(app).get(`/api/documents/products/${product._id}/report`).set(member.auth)
    const segments = new URL(access.body.url).pathname.split('/')
    assert.deepEqual(segments.slice(1, 4), ['api', 'documents', 'access'])
    assert.equal(decodeURIComponent(segments[5]), 'Honda-City-2022-inspection-report.pdf')

    const document = await openLink(access)
    assert.equal(document.status, 200)
    assert.deepEqual(document.body, bytes)
    const withoutName = await request(app).get(`/api/documents/access/${segments[4]}`)
    assert.equal(withoutName.status, 200, 'the trailing name is cosmetic; the signed token alone grants access')
  })
})

test('an auction report opens inline as a PDF named after the car', async () => {
  await withLocalPdf(async asset => {
    const member = await activeMember('doc-auction@example.com', '+92 300 4440002')
    const car = await Car.create({
      make: 'Honda', model: 'Civic', year: 2021, km: 20000, engine: '1800', basePrice: 4_000_000, currentBid: 4_000_000,
      auctionStart: new Date(Date.now() - 3_600_000), auctionEnd: new Date(Date.now() + 86_400_000), inspectionDocument: asset,
    })
    const access = await request(app).get(`/api/documents/auctions/${car._id}/report`).set(member.auth)
    assert.equal(access.status, 200)
    const document = await openLink(access)
    assert.equal(document.status, 200)
    assert.equal(document.headers['content-disposition'], 'inline; filename="Honda-Civic-2021-inspection-report.pdf"')
  })
})

test('a booking document is named by its kind', async () => {
  await withLocalPdf(async asset => {
    const owner = await activeMember('doc-booking@example.com', '+92 300 4440003')
    const booking = await Booking.create({
      memberId: owner.id, name: 'Document Owner', email: 'doc-booking@example.com', phone: '+923001112233',
      carMake: 'Honda', carModel: 'City', date: '2026-09-15', branch: 'Rawalpindi', cnicDocument: asset,
    })
    const access = await request(app).get(`/api/documents/bookings/${booking._id}/cnic`).set(owner.auth)
    assert.equal(access.status, 200)
    const document = await openLink(access)
    assert.equal(document.headers['content-disposition'], 'inline; filename="cnic-document.pdf"')
  })
})

const cloudAsset = { provider: 'cloudinary', key: 'executive-cars/reports/abc123', resourceType: 'raw', contentType: 'application/pdf', size: bytes.length, extension: '.pdf' }
const SIGNED_URL = 'https://cloudinary.test/signed?sig=secret'

async function cloudReportLink(t, respond) {
  const { cloudinary } = require('../src/config/cloudinary')
  t.mock.method(cloudinary.utils, 'private_download_url', () => SIGNED_URL)
  const fetchMock = t.mock.method(globalThis, 'fetch', respond)
  const member = await activeMember(`doc-cloud-${Math.random().toString(16).slice(2)}@example.com`, `+92 300 ${String(Math.floor(1000000 + Math.random() * 8999999))}`)
  const product = await Product.create({ make: 'Honda', model: 'City', year: 2022, km: 21000, price: 5200000, ownerId: member.id, inspectionDocument: cloudAsset })
  const access = await request(app).get(`/api/documents/products/${product._id}/report`).set(member.auth)
  assert.equal(access.status, 200)
  return { access, fetchMock }
}

test('a Cloudinary report is served through our own link and never exposes the storage address', async t => {
  const { access, fetchMock } = await cloudReportLink(t, async () => new Response(bytes, {
    status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
  }))
  assert.match(access.body.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/documents\/access\//)
  assert.doesNotMatch(JSON.stringify(access.body), /cloudinary\.test/)

  const document = await openLink(access)
  assert.equal(document.status, 200)
  assert.equal(document.headers['content-type'], 'application/pdf', 'the stored type wins over the storage provider')
  assert.equal(document.headers['content-disposition'], 'inline; filename="Honda-City-2022-inspection-report.pdf"')
  assert.match(document.headers['cache-control'], /no-store/)
  assert.deepEqual(document.body, bytes)
  assert.equal(fetchMock.mock.callCount(), 1)
})

test('a Cloudinary report that is gone gives 404 and a broken storage gives 502', async t => {
  const missing = await cloudReportLink(t, async () => new Response('missing', { status: 404 }))
  const gone = await openLink(missing.access)
  assert.equal(gone.status, 404)
  assert.equal(gone.body.message, 'Document is not available')
  t.mock.restoreAll()

  const broken = await cloudReportLink(t, async () => new Response('boom', { status: 500 }))
  assert.equal((await openLink(broken.access)).status, 502)
  t.mock.restoreAll()

  const unreachable = await cloudReportLink(t, async () => { throw new TypeError('fetch failed') })
  const failed = await openLink(unreachable.access)
  assert.equal(failed.status, 502)
  assert.match(failed.body.message, /not reachable/i)
})

test('a storage stream that breaks half way does not take the server down', async t => {
  const broken = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 8))
      setTimeout(() => controller.error(new Error('connection reset')), 20)
    },
  })
  const warn = t.mock.method(console, 'warn', () => {})
  const { access, fetchMock } = await cloudReportLink(t, async () => new Response(broken, { status: 200 }))
  await openLink(access).then(() => {}, () => {})
  assert.equal(fetchMock.mock.callCount(), 1, 'the broken stream was really opened')
  await waitFor(() => warn.mock.calls.some(call => String(call.arguments[0]).includes('document_stream_failure')))
  const health = await request(app).get('/api/health')
  assert.equal(health.status, 200)
})

const waitFor = async (check, milliseconds = 2000) => {
  const until = Date.now() + milliseconds
  while (Date.now() < until) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return Boolean(check())
}
const streamLogged = warn => warn.mock.calls.some(call => String(call.arguments[0]).includes('document_stream_failure'))

test('a local file that cannot be read does not crash the server', async t => {
  await withLocalPdf(async asset => {
    const member = await activeMember('doc-eio@example.com', '+92 300 4440006')
    const product = await Product.create({ make: 'Honda', model: 'City', year: 2022, km: 21000, price: 5200000, ownerId: member.id, inspectionDocument: asset })
    const access = await request(app).get(`/api/documents/products/${product._id}/report`).set(member.auth)
    t.mock.method(require('fs'), 'createReadStream', () => new Readable({ read() { this.destroy(Object.assign(new Error('read failed'), { code: 'EIO' })) } }))
    await openLink(access).then(() => {}, () => {})
    assert.equal((await request(app).get('/api/health')).status, 200)
  })
})

test('a storage that breaks before the first byte still gets a JSON 502', async t => {
  t.mock.method(console, 'warn', () => {})
  const { access } = await cloudReportLink(t, async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')) } }), { status: 200 }))
  const failed = await openLink(access)
  assert.equal(failed.status, 502)
  assert.match(failed.body.message, /not reachable/i)
})

test('a browser that drops the connection is not logged as a storage failure', async t => {
  const warn = t.mock.method(console, 'warn', () => {})
  const dropped = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 8))
      setTimeout(() => controller.error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 20)
    },
  })
  const { access } = await cloudReportLink(t, async () => new Response(dropped, { status: 200 }))
  await openLink(access).then(() => {}, () => {})
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(streamLogged(warn), false)
})

test('a HEAD request is answered from the link alone and never downloads the file', async t => {
  const { access, fetchMock } = await cloudReportLink(t, async () => new Response(bytes, { status: 200 }))
  const head = await request(app).head(new URL(access.body.url).pathname)
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-type'], 'application/pdf')
  assert.equal(head.headers['content-disposition'], 'inline; filename="Honda-City-2022-inspection-report.pdf"')
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('the fetch from storage is stopped when the browser leaves early', async t => {
  let seen
  const { access } = await cloudReportLink(t, (url, options) => {
    seen = options.signal
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
  })
  // supertest closes its temporary server only when a request ends, and an aborted one never does: use our own.
  const server = require('http').createServer(app)
  try {
    const pending = request(server).get(new URL(access.body.url).pathname)
    pending.then(() => {}, () => {})
    assert.ok(await waitFor(() => seen), 'the fetch started')
    pending.abort()
    assert.ok(await waitFor(() => seen.aborted), 'the fetch was aborted')
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('the access route has its own flood guard in front of the handler', () => {
  const layer = documentRouter.stack.find(item => item.route?.path === '/access/:token/:fileName?')
  assert.deepEqual(layer.route.stack.map(item => item.handle), [documentLimiter, accessDocument])
})

test('a stream that is opened but cannot be answered with is released', async t => {
  let released = 0
  const { cloudinary } = require('../src/config/cloudinary')
  t.mock.method(cloudinary.utils, 'private_download_url', () => SIGNED_URL)
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes) },
    cancel() { released += 1 },
  }), { status: 200 }))
  // A validly signed token whose content type cannot be sent as a header.
  const payload = Buffer.from(JSON.stringify({
    key: cloudAsset.key, provider: 'cloudinary', resourceType: 'raw', contentType: 'application/pdf\nX-Evil: 1',
    extension: '.pdf', name: 'x.pdf', exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url')
  const response = await request(app).get(`/api/documents/access/${payload}.${hmac('document', payload)}`)
  assert.equal(response.status, 502)
  assert.ok(await waitFor(() => released === 1), 'the upstream body was cancelled')
})

test('edited provider or key, and an expired Cloudinary link, are refused', async () => {
  await withLocalPdf(async asset => {
    const member = await activeMember('doc-tamper2@example.com', '+92 300 4440007')
    const product = await Product.create({ make: 'Honda', model: 'City', year: 2022, km: 21000, price: 5200000, ownerId: member.id, inspectionDocument: asset })
    const access = await request(app).get(`/api/documents/products/${product._id}/report`).set(member.auth)
    const [payload, signature] = decodeURIComponent(new URL(access.body.url).pathname.split('/')[4]).split('.')
    const original = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    for (const change of [{ provider: 'cloudinary' }, { key: 'other-file.pdf' }]) {
      const forged = `${Buffer.from(JSON.stringify({ ...original, ...change })).toString('base64url')}.${signature}`
      assert.equal((await request(app).get(`/api/documents/access/${encodeURIComponent(forged)}`)).status, 403)
    }
    const old = Buffer.from(JSON.stringify({ ...original, provider: 'cloudinary', key: cloudAsset.key, exp: 1 })).toString('base64url')
    assert.equal((await request(app).get(`/api/documents/access/${old}.${hmac('document', old)}`)).status, 403)
  })
})

test('a link whose file name was edited is refused', async () => {
  await withLocalPdf(async asset => {
    const member = await activeMember('doc-tamper@example.com', '+92 300 4440004')
    const product = await Product.create({ make: 'Honda', model: 'City', year: 2022, km: 21000, price: 5200000, ownerId: member.id, inspectionDocument: asset })
    const access = await request(app).get(`/api/documents/products/${product._id}/report`).set(member.auth)
    const token = decodeURIComponent(new URL(access.body.url).pathname.split('/')[4])
    const [payload, signature] = token.split('.')
    const edited = { ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), name: 'evil.exe' }
    const forged = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${signature}`
    const refused = await request(app).get(`/api/documents/access/${encodeURIComponent(forged)}`)
    assert.equal(refused.status, 403)
    assert.equal(refused.body.message, 'Document link is invalid or expired')
  })
})
