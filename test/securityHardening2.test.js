process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'smtp'
process.env.ENABLE_DEMO_SEED = 'true'
const { DEFAULT_TEST_URI, validateTestUri, connectTestDatabase, dropTestDatabase, resetTestDatabase } = require('./helpers/localDatabase')
process.env.MONGO_URI = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GROQ_API_KEY', 'ML_SERVICE_KEY', 'RESEND_API_KEY']) process.env[key] = ''

const { before, after, beforeEach, afterEach, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const axios = require('axios')
const mongoose = require('mongoose')
require('./helpers/noRateLimits')
const request = require('supertest')
require('./helpers/cookieAuth')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const Booking = require('../src/models/Booking')
const Car = require('../src/models/Car')
const EmailVerificationCode = require('../src/models/EmailVerificationCode')
const Member = require('../src/models/Member')
const OtpChallenge = require('../src/models/OtpChallenge')
const PasswordResetCode = require('../src/models/PasswordResetCode')
const Product = require('../src/models/Product')
const Session = require('../src/models/Session')
const { hmac } = require('../src/utils/crypto')
const { privateUploadDir, uploadedFileUrl } = require('../src/config/cloudinary')
const { sendBookingConfirmationEmail } = require('../src/utils/email')

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
const person = { name: 'Booking Tester', email: 'booking-tester@example.com', phone: '+92 300 5550601', password: 'orchid-lantern-42' }
const register = async (account = person) => (await request(app).post('/api/auth/register').send(account)).body
const adminToken = async () => {
  await Admin.create({ name: 'Booking Admin', email: 'booking-admin@example.com', password: 'admin-pass-123', role: 'admin' })
  return (await request(app).post('/api/auth/admin/login').send({ email: 'booking-admin@example.com', password: 'admin-pass-123' })).body.token
}
const futureDate = (days = 3) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const bookingFields = (overrides = {}) => ({
  name: person.name, email: person.email, phone: person.phone, carMake: 'Honda', carModel: 'Civic', carYear: '2021',
  mileage: '45000', engineCC: '1800', date: futureDate(), time: '10:00 AM', branch: 'Islamabad Showroom', ...overrides,
})
const verifiedCode = (email = person.email) => OtpChallenge.create({ email, otpDigest: 'not-compared', expiresAt: new Date(Date.now() + 600_000), verified: true })
const pendingCode = (otp = '123456', email = person.email) => OtpChallenge.create({
  email, otpDigest: hmac('otp', `${email}:${otp}`, 'hex'), expiresAt: new Date(Date.now() + 600_000),
})
const uploadedFiles = () => (fs.existsSync(privateUploadDir) ? fs.readdirSync(privateUploadDir).length : 0)
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])

describe('the booking code', () => {
  test('wrong guesses are counted atomically: parallel requests cannot get past five', async () => {
    const { token } = await register()
    await pendingCode('123456')
    const verify = otp => request(app).post('/api/bookings/verify-otp').set(asBearer(token)).send({ otp })
    const results = await Promise.all(Array.from({ length: 14 }, () => verify('000000')))
    assert.ok(results.every(result => [400, 429].includes(result.status)))
    assert.equal((await OtpChallenge.findOne()).attempts, 5, 'no more than five guesses are ever counted or compared')
    const late = await verify('123456')
    assert.equal(late.status, 429)
    assert.match(late.body.message, /Too many incorrect attempts/)
    assert.equal((await OtpChallenge.findOne()).verified, false)
  })

  test('the right code verifies once; a second verification finds nothing pending', async () => {
    const { token } = await register()
    await pendingCode('654321')
    const first = await request(app).post('/api/bookings/verify-otp').set(asBearer(token)).send({ otp: '654321' })
    assert.equal(first.status, 200)
    assert.equal((await OtpChallenge.findOne()).verified, true)
    assert.ok((await Member.findOne({ email: person.email })).emailVerifiedAt, 'the booking code also proves the address')
    const again = await request(app).post('/api/bookings/verify-otp').set(asBearer(token)).send({ otp: '654321' })
    assert.equal(again.status, 400)
    assert.match(again.body.message, /No pending OTP/)
  })

  test('an expired code is removed and reported; a wrong one is reported as wrong', async () => {
    const { token } = await register()
    await pendingCode('111111')
    const wrong = await request(app).post('/api/bookings/verify-otp').set(asBearer(token)).send({ otp: '222222' })
    assert.equal(wrong.body.message, 'Incorrect OTP')
    await OtpChallenge.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    const expired = await request(app).post('/api/bookings/verify-otp').set(asBearer(token)).send({ otp: '111111' })
    assert.equal(expired.status, 400)
    assert.equal(expired.body.message, 'OTP has expired')
    assert.equal(await OtpChallenge.countDocuments(), 0)
    assert.equal((await request(app).post('/api/bookings/verify-otp').set(asBearer(token)).send({ otp: 'abc' })).status, 400)
  })
})

describe('uploads happen only after the code is confirmed', () => {
  test('the booking route checks the confirmed code and the flood guard before it accepts any upload', () => {
    const { bookingLimiter } = require('../src/middleware/rateLimits')
    const verifiedBookingCode = require('../src/middleware/verifiedBookingCode')
    const { docUpload } = require('../src/config/cloudinary')
    const { submitBooking } = require('../src/controllers/bookingController')
    const router = require('../src/routes/bookings')
    const layer = router.stack.find(item => item.route?.path === '/' && item.route.methods.post)
    const handlers = layer.route.stack.map(item => item.handle)
    assert.deepEqual(handlers, [bookingLimiter, verifiedBookingCode, docUpload, submitBooking])
  })

  test('a booking with documents and no confirmed code is refused before anything is stored', async () => {
    const { token } = await register()
    const before = uploadedFiles()
    const response = await request(app).post('/api/bookings').set(asBearer(token))
      .field('name', person.name).field('phone', person.phone)
      .attach('cnicImage', png, { filename: 'cnic.png', contentType: 'image/png' })
    assert.equal(response.status, 400)
    assert.match(response.body.message, /OTP verification required/)
    assert.equal(uploadedFiles(), before, 'no file may reach the disk or storage')
    assert.equal(await Booking.countDocuments(), 0)
  })

  test('an expired confirmation does not count', async () => {
    const { token } = await register()
    await verifiedCode()
    await OtpChallenge.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    const response = await request(app).post('/api/bookings').set(asBearer(token)).send(bookingFields())
    assert.equal(response.status, 400)
  })

  test('with a confirmed code a booking is accepted, and the code is used up', async () => {
    const { token } = await register()
    await verifiedCode()
    const response = await request(app).post('/api/bookings').set(asBearer(token)).send(bookingFields())
    assert.equal(response.status, 201)
    assert.equal(await OtpChallenge.countDocuments(), 0)
    assert.equal((await request(app).post('/api/bookings').set(asBearer(token)).send(bookingFields({ carModel: 'City' }))).status, 400)
  })

  test('limits on the text of a booking are enforced', async () => {
    const { token } = await register()
    await verifiedCode()
    const response = await request(app).post('/api/bookings').set(asBearer(token)).send(bookingFields({
      carMake: 'M'.repeat(61), carModel: 'X'.repeat(61), branch: 'B'.repeat(81), time: 'T'.repeat(21), date: '12/31/2030',
    }))
    assert.equal(response.status, 400)
    for (const field of ['carMake', 'carModel', 'branch', 'time', 'date']) assert.ok(response.body.errors[field], field)
    assert.equal(await Booking.countDocuments(), 0)
    assert.equal(await OtpChallenge.countDocuments(), 1, 'a refused booking does not use up the code')
  })

  test('the confirmation e-mail shows what the customer typed as plain text, never as markup', async t => {
    const sent = []
    const original = axios.post
    const previous = { mode: process.env.EMAIL_DELIVERY_MODE, key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL }
    process.env.EMAIL_DELIVERY_MODE = 'resend'
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.RESEND_FROM_EMAIL = 'no-reply@account.example.com'
    axios.post = async (url, payload) => { sent.push(payload); return { data: { id: 'email-id' } } }
    t.after(() => {
      axios.post = original
      process.env.EMAIL_DELIVERY_MODE = previous.mode
      process.env.RESEND_API_KEY = previous.key
      process.env.RESEND_FROM_EMAIL = previous.from
    })
    await sendBookingConfirmationEmail('a@example.com', '<script>alert(1)</script>', '2030-01-01', '<img src=x onerror=alert(2)>')
    const html = sent[0].html
    assert.ok(!html.includes('<script>') && !html.includes('<img'))
    assert.match(html, /&lt;script&gt;/)
    assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/)
  })
})

describe('uploaded images are addressed by a path on this site', () => {
  test('a local image path never depends on the Host header; Cloudinary addresses pass through; private files are refused', () => {
    assert.equal(uploadedFileUrl({ fieldname: 'images', filename: 'a b.jpg', path: '/tmp/x' }), '/uploads/images/a%20b.jpg')
    assert.equal(uploadedFileUrl({ fieldname: 'images', filename: 'x', path: 'https://res.cloudinary.com/demo/image/upload/x.jpg' }), 'https://res.cloudinary.com/demo/image/upload/x.jpg')
    assert.equal(uploadedFileUrl(undefined), '')
    assert.throws(() => uploadedFileUrl({ fieldname: 'cnicImage', filename: 'x', path: '/tmp/x' }), /cannot be exposed/)
  })
})

describe('the booking life cycle and seller approval', () => {
  const booking = (member, overrides = {}) => Booking.create({
    memberId: member._id, name: member.name, email: member.email, phone: '+923005550601', carMake: 'Honda', carModel: 'Civic', date: futureDate(), branch: 'Main', ...overrides,
  })
  const setStatus = (admin, id, status) => request(app).patch(`/api/admin/bookings/${id}`).set(asBearer(admin)).send({ status })

  test('approval goes to the account that made the booking, found by id', async () => {
    await register()
    const member = await Member.findOne({ email: person.email })
    const row = await booking(member, { email: 'different-address@example.com' })
    const admin = await adminToken()
    const approved = await setStatus(admin, row._id, 'approved')
    assert.equal(approved.status, 200)
    const after = await Member.findById(member._id)
    assert.equal(after.sellerApproved, true)
    assert.equal(String(after.sellerBookingId), String(row._id))
  })

  test('a booking with no owner cannot be approved, and is left as it was', async () => {
    await register()
    const member = await Member.findOne({ email: person.email })
    const orphan = await booking(member)
    await Booking.collection.updateOne({ _id: orphan._id }, { $unset: { memberId: 1 } })
    const response = await setStatus(await adminToken(), orphan._id, 'approved')
    assert.equal(response.status, 409)
    assert.equal((await Booking.findById(orphan._id)).status, 'pending')
    assert.equal((await Member.findById(member._id)).sellerApproved, false)
  })

  test('rejecting or cancelling the booking that gave the approval takes the approval back; approving again restores it', async () => {
    await register()
    const member = await Member.findOne({ email: person.email })
    const row = await booking(member)
    const admin = await adminToken()
    await setStatus(admin, row._id, 'approved')
    assert.equal((await Member.findById(member._id)).sellerApproved, true)

    const rejected = await setStatus(admin, row._id, 'rejected')
    assert.equal(rejected.status, 200)
    const revoked = await Member.findById(member._id)
    assert.equal(revoked.sellerApproved, false)
    assert.equal(revoked.sellerBookingId, undefined)
    assert.equal((await Booking.findById(row._id)).sellerCreated, false)

    await setStatus(admin, row._id, 'approved')
    assert.equal((await Member.findById(member._id)).sellerApproved, true)
    await setStatus(admin, row._id, 'cancelled')
    assert.equal((await Member.findById(member._id)).sellerApproved, false)
  })

  test('another approved booking keeps the approval alive', async () => {
    await register()
    const member = await Member.findOne({ email: person.email })
    const first = await booking(member)
    const second = await booking(member, { carModel: 'City' })
    const admin = await adminToken()
    await setStatus(admin, first._id, 'approved')
    await setStatus(admin, second._id, 'approved')
    // The approval is tied to the booking approved last. Rejecting an earlier one changes nothing...
    await setStatus(admin, first._id, 'rejected')
    const after = await Member.findById(member._id)
    assert.equal(after.sellerApproved, true)
    assert.equal(String(after.sellerBookingId), String(second._id))
    // ...and rejecting the one that holds it hands the approval to another standing booking, if there is one.
    await setStatus(admin, first._id, 'approved')
    assert.equal(String((await Member.findById(member._id)).sellerBookingId), String(first._id), 'approving again makes this booking the holder')
    await setStatus(admin, first._id, 'rejected')
    const handedOver = await Member.findById(member._id)
    assert.equal(handedOver.sellerApproved, true)
    assert.equal(String(handedOver.sellerBookingId), String(second._id))
    await setStatus(admin, second._id, 'rejected')
    assert.equal((await Member.findById(member._id)).sellerApproved, false, 'with no booking left standing, the approval ends')
  })

  test('confirming or completing a booking does not touch the approval, and a finished booking cannot be changed', async () => {
    await register()
    const member = await Member.findOne({ email: person.email })
    const row = await booking(member)
    const admin = await adminToken()
    await setStatus(admin, row._id, 'approved')
    await setStatus(admin, row._id, 'confirmed')
    await setStatus(admin, row._id, 'completed')
    assert.equal((await Member.findById(member._id)).sellerApproved, true)
    const reopened = await setStatus(admin, row._id, 'rejected')
    assert.equal(reopened.status, 409)
    assert.equal(reopened.body.code, 'BOOKING_CLOSED')
    assert.equal((await Booking.findById(row._id)).status, 'completed')
    assert.equal((await Member.findById(member._id)).sellerApproved, true)
    assert.equal((await setStatus(admin, row._id, 'completed')).status, 200, 'repeating the same status is harmless')
    assert.equal((await setStatus(admin, row._id, 'pending')).status, 400)
  })

  test('deleting the booking that gave the approval takes it back', async () => {
    await register()
    const member = await Member.findOne({ email: person.email })
    const row = await booking(member)
    const admin = await adminToken()
    await setStatus(admin, row._id, 'approved')
    const removed = await request(app).delete(`/api/admin/bookings/${row._id}`).set(asBearer(admin))
    assert.equal(removed.status, 200)
    assert.equal((await Member.findById(member._id)).sellerApproved, false)
  })
})

describe('removing a customer', () => {
  test('signs them out everywhere and leaves nothing that could still verify them or reset their password', async () => {
    const { token } = await register()
    const member = await Member.findOne({ email: person.email })
    await EmailVerificationCode.create({ accountId: member._id, email: person.email, otpDigest: 'x', expiresAt: new Date(Date.now() + 60_000), lastSentAt: new Date(), dayStartedAt: new Date() })
    await PasswordResetCode.create({ accountModel: 'member', accountId: member._id, otpDigest: 'x', expiresAt: new Date(Date.now() + 60_000) })
    await pendingCode('123456')
    const listing = await Product.create({ make: 'Toyota', model: 'Corolla', year: 2020, km: 1, price: 1_000_000, ownerId: member._id, sellerEmail: person.email })
    const car = await Car.create({ make: 'Honda', model: 'Civic', year: 2021, km: 1, engine: '1800', basePrice: 1, currentBid: 1, auctionStart: new Date(), auctionEnd: new Date(Date.now() + 86_400_000), ownerId: member._id, sellerEmail: person.email })

    const removed = await request(app).delete(`/api/admin/members/${member._id}`).set(asBearer(await adminToken()))
    assert.equal(removed.status, 200)
    const after = await request(app).get('/api/auth/session').set(asBearer(token))
    assert.equal(after.status, 401)
    assert.equal(after.body.code, 'SESSION_REVOKED')
    assert.equal((await Session.findOne({ accountId: member._id })).revokedReason, 'account_deleted')
    assert.equal(await EmailVerificationCode.countDocuments(), 0)
    assert.equal(await PasswordResetCode.countDocuments(), 0)
    assert.equal(await OtpChallenge.countDocuments(), 0)
    assert.equal((await Product.findById(listing._id)).ownerId, undefined)
    assert.equal((await Car.findById(car._id)).sellerEmail, '')
  })
})

describe('the model service', () => {
  const stubbed = {}
  beforeEach(() => { stubbed.get = axios.get; stubbed.post = axios.post })
  afterEach(() => { axios.get = stubbed.get; axios.post = stubbed.post })

  test('a network failure never shows the internal address to the administrator', async () => {
    axios.get = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' }) }
    axios.post = axios.get
    const token = await adminToken()
    const versions = await request(app).get('/api/admin/model-versions').set(asBearer(token))
    assert.equal(versions.status, 503)
    assert.equal(versions.body.message, 'Could not load model versions')
    for (const [method, path] of [['post', '/api/admin/model-rollback'], ['post', '/api/admin/model-versions/v1/activate']]) {
      const response = await request(app)[method](path).set(asBearer(token))
      assert.equal(response.status, 503)
      assert.ok(!JSON.stringify(response.body).includes('127.0.0.1'))
    }
  })

  test('a refusal the service explains is passed on; a server-side detail is not', async () => {
    const token = await adminToken()
    axios.post = async () => { throw Object.assign(new Error('Request failed'), { response: { status: 409, data: { detail: 'There is no previous model to return to.' } } }) }
    const refusal = await request(app).post('/api/admin/model-rollback').set(asBearer(token))
    assert.equal(refusal.status, 409)
    assert.equal(refusal.body.message, 'There is no previous model to return to.')
    axios.post = async () => { throw Object.assign(new Error('Request failed'), { response: { status: 500, data: { detail: 'Traceback (most recent call last): File "/srv/app/main.py"' } } }) }
    const failure = await request(app).post('/api/admin/model-rollback').set(asBearer(token))
    assert.equal(failure.status, 503)
    assert.ok(!failure.body.message.includes('Traceback'))
  })
})

describe('dataset imports', () => {
  test('the source description and file name are bounded', async () => {
    const token = await adminToken()
    const csv = Buffer.from('make,model,year,mileage,price\nToyota,Corolla,2020,40000,5000000\n')
    const longSource = await request(app).post('/api/admin/dataset-imports').set(asBearer(token))
      .field('source', 'S'.repeat(201)).field('rightsConfirmed', 'true').attach('dataset', csv, { filename: 'cars.csv', contentType: 'text/csv' })
    assert.equal(longSource.status, 400)
    assert.match(longSource.body.message, /source must be at most 200/)
    const longName = await request(app).post('/api/admin/dataset-imports').set(asBearer(token))
      .field('source', 'Showroom export').field('rightsConfirmed', 'true').attach('dataset', csv, { filename: `${'n'.repeat(201)}.csv`, contentType: 'text/csv' })
    assert.equal(longName.status, 400)
    assert.match(longName.body.message, /file name must be at most 200/)
  })
})
