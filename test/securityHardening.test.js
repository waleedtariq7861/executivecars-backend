process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'smtp'
process.env.ENABLE_DEMO_SEED = 'true'
const { DEFAULT_TEST_URI, validateTestUri, connectTestDatabase, dropTestDatabase, resetTestDatabase } = require('./helpers/localDatabase')
process.env.MONGO_URI = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GROQ_API_KEY', 'ML_SERVICE_KEY', 'RESEND_API_KEY']) process.env[key] = ''

const { before, after, beforeEach, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const mongoose = require('mongoose')
require('./helpers/noRateLimits')
const request = require('supertest')
require('./helpers/cookieAuth')
const { createApp, trustedProxyHops } = require('../server/app')
const Admin = require('../src/models/Admin')
const Bid = require('../src/models/Bid')
const Car = require('../src/models/Car')
const Member = require('../src/models/Member')
const Product = require('../src/models/Product')
const { isValidEmail } = require('../src/utils/inputValidation')
const { queryText, oneOf, boundedText } = require('../src/utils/http')

let app

before(async () => {
  await connectTestDatabase()
  app = createApp()
})

after(async () => {
  if (mongoose.connection.readyState === 1) {
    try { await dropTestDatabase() } finally { await mongoose.disconnect() }
  }
})

beforeEach(async () => { await resetTestDatabase() })

const asBearer = token => ({ Authorization: `Bearer ${token}` })
const person = { name: 'Hardening Tester', email: 'hardening@example.com', phone: '+92 300 5550501', password: 'orchid-lantern-42' }
const owner = { name: 'Listing Owner', email: 'listing-owner@example.com', phone: '+92 300 5550502', password: 'orchid-lantern-43' }

const register = async (account = person) => (await request(app).post('/api/auth/register').send(account)).body
const activateMembership = id => Member.updateOne({ _id: id }, { $set: {
  subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 30 * 86_400_000), emailVerifiedAt: new Date(),
} })
const customer = async (account = person, { member = false } = {}) => {
  const body = await register(account)
  const record = await Member.findOne({ email: account.email })
  if (member) await activateMembership(record._id)
  return { token: body.token, record }
}
const adminToken = async () => {
  await Admin.create({ name: 'Hardening Admin', email: 'hardening-admin@example.com', password: 'admin-pass-123', role: 'admin' })
  return (await request(app).post('/api/auth/admin/login').send({ email: 'hardening-admin@example.com', password: 'admin-pass-123' })).body.token
}
const product = (overrides = {}) => Product.create({ make: 'Toyota', model: 'Corolla', year: 2020, km: 40000, price: 5_000_000, fuel: 'Petrol', transmission: 'Auto', ...overrides })
const auction = (overrides = {}) => Car.create({
  make: 'Honda', model: 'Civic', year: 2021, km: 20000, engine: '1800', basePrice: 4_000_000, currentBid: 4_000_000,
  auctionStart: new Date(Date.now() - 3_600_000), auctionEnd: new Date(Date.now() + 86_400_000), ...overrides,
})

describe('what the public used-car listing reveals', () => {
  test('no owner, e-mail address or internal field leaves the server, in the list or on a single listing', async () => {
    const { record } = await customer(owner)
    const listing = await product({ ownerId: record._id, sellerEmail: owner.email, description: 'Clean car' })
    const list = await request(app).get('/api/products')
    const one = await request(app).get(`/api/products/${listing._id}`)
    for (const body of [list.body[0], one.body]) {
      assert.equal(body.make, 'Toyota')
      assert.equal(body.description, 'Clean car')
      for (const forbidden of ['ownerId', 'sellerEmail', 'inspectionDocument', '__v', 'pdfUrl']) assert.equal(body[forbidden], undefined, `${forbidden} must not be public`)
    }
    assert.ok(!JSON.stringify(list.body).includes(owner.email))
    assert.ok(!JSON.stringify(list.body).includes(String(record._id)))
  })

  test('a saved car is shown the same way', async () => {
    const { token, record } = await customer(person)
    const listing = await product({ ownerId: record._id, sellerEmail: 'someone@example.com' })
    await request(app).post(`/api/member/saved-cars/${listing._id}`).set(asBearer(token))
    const saved = await request(app).get('/api/member/saved-cars').set(asBearer(token))
    assert.equal(saved.body.cars.length, 1)
    assert.equal(saved.body.cars[0].ownerId, undefined)
    assert.equal(saved.body.cars[0].sellerEmail, undefined)
    const added = await request(app).post(`/api/member/saved-cars/${listing._id}`).set(asBearer(token))
    assert.equal(added.body.car.sellerEmail, undefined)
  })
})

describe('the reserve price stays secret from bidders', () => {
  test('auction list and detail show whether a reserve exists and is met, never its amount', async () => {
    const { token } = await customer(person, { member: true })
    const withReserve = await auction({ reservePrice: 5_000_000, currentBid: 4_000_000 })
    const metReserve = await auction({ make: 'Suzuki', model: 'Alto', reservePrice: 3_000_000, currentBid: 4_000_000 })
    const noReserve = await auction({ make: 'Kia', model: 'Picanto' })
    const list = await request(app).get('/api/cars').set(asBearer(token))
    const byId = Object.fromEntries(list.body.map(car => [car._id, car]))
    assert.equal(byId[withReserve._id].hasReserve, true)
    assert.equal(byId[withReserve._id].reserveMet, false)
    assert.equal(byId[metReserve._id].reserveMet, true)
    assert.equal(byId[noReserve._id].hasReserve, false)
    assert.equal(byId[noReserve._id].reserveMet, true)
    assert.ok(!JSON.stringify(list.body).includes('5000000'), 'the reserve amount must not appear anywhere')
    const detail = await request(app).get(`/api/cars/${withReserve._id}`).set(asBearer(token))
    assert.equal(detail.body.reservePrice, undefined)
    assert.equal(detail.body.ownerId, undefined)
    assert.equal(detail.body.sellerEmail, undefined)
  })

  test('bid history and won cars do not reveal it either', async () => {
    const { token, record } = await customer(person, { member: true })
    const mine = await auction({ reservePrice: 4_000_000, currentBid: 4_500_000, highestBidder: record._id, status: 'ended', sellerEmail: 'seller@example.com' })
    await Bid.create({ carId: mine._id, bidderId: record._id, amount: 4_500_000 })
    const history = await request(app).get('/api/member/bids').set(asBearer(token))
    assert.equal(history.body[0].carId.reservePrice, undefined)
    assert.deepEqual(history.body[0].auctionState, { status: 'won', biddingOpen: false })
    const won = await request(app).get('/api/member/won').set(asBearer(token))
    assert.equal(won.body.length, 1)
    for (const forbidden of ['reservePrice', 'ownerId', 'sellerEmail']) assert.equal(won.body[0][forbidden], undefined)
    assert.equal(won.body[0].highestBidder.name, 'You')
  })

  test('the listing owner and administrators still see the real reserve', async () => {
    const { token, record } = await customer(owner, { member: true })
    await auction({ reservePrice: 5_000_000, ownerId: record._id })
    const own = await request(app).get('/api/seller/auction-status').set(asBearer(token))
    assert.equal(own.body[0].reservePrice, 5_000_000)
    const admin = await request(app).get('/api/admin/cars').set(asBearer(await adminToken()))
    assert.equal(admin.body[0].reservePrice, 5_000_000)
  })
})

describe('query strings cannot carry database operators', () => {
  test('the API parses query strings as flat text', () => {
    assert.equal(app.get('query parser'), 'simple')
  })

  test('operator-shaped parameters on public and member lists are ignored, not executed', async () => {
    await product({ fuel: 'Petrol' })
    await product({ make: 'Honda', model: 'City', fuel: 'Diesel' })
    const all = await request(app).get('/api/products')
    const injected = await request(app).get('/api/products?fuel[$ne]=Petrol&make[$regex]=.*&transmission[$exists]=false')
    assert.equal(injected.status, 200)
    assert.equal(injected.body.length, all.body.length, 'the operators must not have filtered anything')
    assert.equal((await request(app).get('/api/products?fuel=Diesel')).body.length, 1)

    const { token } = await customer(person, { member: true })
    await auction()
    await auction({ make: 'Closed', status: 'ended', auctionEnd: new Date(Date.now() - 1000), auctionStart: new Date(Date.now() - 86_400_000) })
    const cars = await request(app).get('/api/cars?status[$ne]=active&phase=all').set(asBearer(token))
    assert.equal(cars.status, 200)
    assert.deepEqual(cars.body.map(car => car.status), ['active'], 'the status operator was ignored, so the default (active) applied')
  })

  test('a repeated or unknown value is refused with a clear message', async () => {
    const repeatedFuel = await request(app).get('/api/products?fuel=Petrol&fuel=Diesel')
    assert.equal(repeatedFuel.status, 400)
    assert.match(repeatedFuel.body.message, /fuel must be a single value/)
    const repeatedPrice = await request(app).get('/api/products?min_price=1&min_price=2')
    assert.equal(repeatedPrice.status, 400)
    assert.match(repeatedPrice.body.message, /min_price must be a single value/)
    const { token } = await customer(person, { member: true })
    const status = await request(app).get('/api/cars?status=%24where').set(asBearer(token))
    assert.equal(status.status, 400)
    assert.match(status.body.message, /status must be one of/)
    const repeatedStatus = await request(app).get('/api/cars?status=ended&status=active').set(asBearer(token))
    assert.equal(repeatedStatus.status, 400)
    assert.match(repeatedStatus.body.message, /status must be a single value/)
  })

  test('the empty status the ended list sends still means "any status"', async () => {
    const { token } = await customer(person, { member: true })
    await auction({ status: 'ended', auctionStart: new Date(Date.now() - 86_400_000), auctionEnd: new Date(Date.now() - 1000) })
    const ended = await request(app).get('/api/cars?phase=ended&status=').set(asBearer(token))
    assert.equal(ended.status, 200)
    assert.equal(ended.body.length, 1)
  })

  test('administrator lists validate their filters too', async () => {
    const token = await adminToken()
    assert.equal((await request(app).get('/api/admin/bookings?status=%24ne').set(asBearer(token))).status, 400)
    assert.equal((await request(app).get('/api/admin/bookings?status=pending&status=approved').set(asBearer(token))).status, 400)
    assert.equal((await request(app).get('/api/admin/members?status=bogus').set(asBearer(token))).status, 400)
    assert.equal((await request(app).get('/api/admin/members?search=a&search=b').set(asBearer(token))).status, 400)
    assert.equal((await request(app).get('/api/admin/bookings?status=pending').set(asBearer(token))).status, 200)
    assert.equal((await request(app).get('/api/admin/members?status=active&page=1&limit=5').set(asBearer(token))).status, 200)
  })

  test('the helpers accept only single text values', () => {
    assert.equal(queryText(undefined), undefined)
    assert.equal(queryText(''), undefined)
    assert.equal(queryText('  Toyota '), 'Toyota')
    assert.throws(() => queryText(['a', 'b'], 'make'), /make must be a single value/)
    assert.throws(() => queryText({ $ne: 'x' }), /single value/)
    assert.equal(oneOf('active', ['active', 'ended']), 'active')
    assert.equal(oneOf(undefined, ['active']), undefined)
    assert.throws(() => oneOf('draft', ['active', 'ended'], 'status'), /status must be one of: active, ended/)
    assert.equal(boundedText('  hello ', 10), 'hello')
    assert.equal(boundedText(undefined, 10), '')
    assert.throws(() => boundedText('x'.repeat(11), 10, 'branch'), /branch must be at most 10 characters/)
    for (const failure of [() => queryText([]), () => oneOf('x', ['y']), () => boundedText('xx', 1)]) {
      try { failure() } catch (error) { assert.equal(error.status, 400) }
    }
  })
})

describe('cookies, e-mail addresses and stored passwords', () => {
  test('a cookie with broken percent-encoding is just not a session', async () => {
    const response = await request(app).get('/api/auth/session').set('Cookie', 'ec_session=%E0%A4%A; other=%zz')
    assert.equal(response.status, 401)
    const publicPage = await request(app).get('/api/products').set('Cookie', 'x=%E0%A4%A')
    assert.equal(publicPage.status, 200)
    const write = await request(app).post('/api/auth/login').set('Cookie', 'ec_session=%E0%A4%A').send({ email: 'nobody@example.com', password: 'wrong-password-1' })
    assert.equal(write.status, 401)
  })

  test('an e-mail address that could carry markup, a second recipient or link parameters is refused', async () => {
    const valid = ['a@b.co', 'first.last+tag@example.com', 'name_1%x@sub.example.co.uk']
    const invalid = ['', 'plain', 'a b@example.com', '"quoted"@example.com', 'a<b>@example.com', 'a?bcc=x@y.com@example.com', 'a/b@example.com', 'a@b', 'a@-b.com', 'a@b..com', `${'x'.repeat(65)}@example.com`, `a@${'x'.repeat(250)}.com`, 'a@example.c', undefined, 42, null]
    for (const address of valid) assert.equal(isValidEmail(address), true, address)
    for (const address of invalid) assert.equal(isValidEmail(address), false, String(address))
    for (const address of ['a?bcc=x@y.com@example.com', '"x"@example.com', 'a<script>@example.com']) {
      const response = await request(app).post('/api/auth/register').send({ ...person, email: address })
      assert.equal(response.status, 400, address)
      assert.equal(await Member.countDocuments(), 0)
    }
    assert.equal((await request(app).post('/api/auth/login').send({ email: 'a?b@x.com', password: 'whatever-pass-1' })).status, 400)
    assert.equal((await request(app).post('/api/auth/forgot-password').send({ email: '"x"@example.com' })).status, 400)
  })

  test('the stored password hash is not part of any serialized account', async () => {
    await register()
    const member = await Member.findOne({ email: person.email })
    assert.match(member.password, /^\$argon2id\$/, 'the document itself still holds the hash for verification')
    assert.equal(JSON.parse(JSON.stringify(member)).password, undefined)
    assert.equal(member.toObject().password, undefined)
    assert.equal(await member.matchPassword(person.password), true)
    const admin = await Admin.create({ name: 'Plain Admin', email: 'plain-admin@example.com', password: 'admin-pass-123', role: 'admin' })
    assert.equal(JSON.parse(JSON.stringify(admin)).password, undefined)
    assert.equal(await (await Admin.findById(admin._id)).matchPassword('admin-pass-123'), true)
  })
})

describe('ownership means the assigned account, not an e-mail address', () => {
  test('an e-mail match alone opens no private report and does not stop a bid', async () => {
    const { token, record } = await customer(person)
    await Member.updateOne({ _id: record._id }, { $set: { subscriptionStatus: 'inactive' } })
    const carByEmail = await auction({ sellerEmail: person.email, inspectionDocument: { provider: 'local', key: 'r.pdf', resourceType: 'raw', contentType: 'application/pdf', size: 5 } })
    const denied = await request(app).get(`/api/documents/auctions/${carByEmail._id}/report`).set(asBearer(token))
    assert.equal(denied.status, 403)

    await activateMembership(record._id)
    const otherCar = await auction({ sellerEmail: person.email })
    const bid = await request(app).post('/api/bids').set(asBearer(token)).send({ carId: String(otherCar._id), amount: 4_100_000 })
    assert.equal(bid.status, 201)
  })

  test('the real owner is still kept from bidding on their own car and can open its report', async () => {
    const { token, record } = await customer(person, { member: true })
    const mine = await auction({ ownerId: record._id, inspectionDocument: { provider: 'local', key: 'r.pdf', resourceType: 'raw', contentType: 'application/pdf', size: 5 } })
    const bid = await request(app).post('/api/bids').set(asBearer(token)).send({ carId: String(mine._id), amount: 4_100_000 })
    assert.equal(bid.status, 403)
    await Member.updateOne({ _id: record._id }, { $set: { subscriptionStatus: 'inactive' } })
    const report = await request(app).get(`/api/documents/auctions/${mine._id}/report`).set(asBearer(token))
    assert.equal(report.status, 200)
  })
})

describe('how many proxies the API trusts', () => {
  test('defaults to one and accepts 1 to 5', () => {
    assert.equal(trustedProxyHops({}), 1)
    assert.equal(trustedProxyHops({ TRUST_PROXY_HOPS: '' }), 1)
    assert.equal(trustedProxyHops({ TRUST_PROXY_HOPS: '2' }), 2)
    assert.equal(trustedProxyHops({ TRUST_PROXY_HOPS: '5' }), 5)
  })

  test('refuses anything else instead of guessing', () => {
    for (const value of ['0', '6', '-1', '1.5', 'abc', 'true', ' ']) {
      assert.throws(() => trustedProxyHops({ TRUST_PROXY_HOPS: value }), /TRUST_PROXY_HOPS must be a whole number from 1 to 5/, value)
    }
  })

  test('the app uses the configured depth', () => {
    assert.equal(app.get('trust proxy'), 1)
  })
})
