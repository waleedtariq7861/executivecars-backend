process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'development'
process.env.ENABLE_DEMO_SEED = 'true'
process.env.EXPOSE_AUTH_TOKEN_FOR_TESTS = 'true'

const { before, after, beforeEach, test } = require('node:test')
const assert = require('node:assert/strict')
const mongoose = require('mongoose')
const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const request = require('supertest')
const { MongoMemoryServer } = require('mongodb-memory-server')
const { createApp } = require('../server/app')
const Product = require('../src/models/Product')
const Car = require('../src/models/Car')
const Bid = require('../src/models/Bid')
const Admin = require('../src/models/Admin')
const Booking = require('../src/models/Booking')
const Member = require('../src/models/Member')
const MembershipPayment = require('../src/models/MembershipPayment')
const { DEMO_OTP, seedDemo } = require('../scripts/seedDemo')
const { privateUploadDir } = require('../src/config/cloudinary')
const { validateRuntimeConfig } = require('../src/config/runtime')

let database
let app

before(async () => {
  database = await MongoMemoryServer.create()
  await mongoose.connect(database.getUri())
  app = createApp()
})

after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect()
  if (database) await database.stop()
})

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase()
})

async function customerToken() {
  const response = await request(app).post('/api/auth/register').send({
    name: 'Test Customer', email: 'customer@example.com', phone: '+92 300 1234567', password: 'test-pass-123',
  })
  assert.equal(response.status, 201)
  const Member = require('../src/models/Member')
  await Member.findByIdAndUpdate(response.body.user.id, { subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 86400000) })
  return response.body.token
}

async function inactiveCustomerToken() {
  const response = await request(app).post('/api/auth/register').send({
    name: 'Inactive Customer', email: 'inactive-customer@example.com', phone: '+92 300 1234500', password: 'test-pass-123',
  })
  assert.equal(response.status, 201)
  return response.body.token
}

const directoryNames = async directory => new Set(await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)))
const waitForDirectory = async (directory, expected, attempts = 20) => {
  for (let index = 0; index < attempts; index += 1) {
    const current = await directoryNames(directory)
    if (current.size === expected.size && [...current].every(name => expected.has(name))) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(await directoryNames(directory), expected)
}

test('health endpoint reports connected database and secure headers', async () => {
  const response = await request(app).get('/api/health')
  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ok')
  assert.equal(response.body.database, 'connected')
  assert.ok(response.headers['x-content-type-options'])
})

test('login and predictor reject invalid input', async () => {
  const login = await request(app).post('/api/auth/login').send({ email: 'not-an-email', password: '' })
  assert.equal(login.status, 400)
  const prediction = await request(app).post('/api/predict-price').send({ make: '', year: 1900, mileage: -1 })
  assert.equal(prediction.status, 400)
  assert.ok(prediction.body.errors.make)
})

test('browser sessions use HttpOnly cookies, restore safely, enforce CSRF, and log out', async () => {
  const browser = request.agent(app)
  const previousExposure = process.env.EXPOSE_AUTH_TOKEN_FOR_TESTS
  delete process.env.EXPOSE_AUTH_TOKEN_FOR_TESTS
  try {
    const registration = await browser.post('/api/auth/register').send({
      name: 'Cookie Session User', email: 'cookie-session@example.com', phone: '+92 300 7778899', password: 'test-pass-123',
    })
    assert.equal(registration.status, 201)
    assert.equal(registration.body.token, undefined)
    assert.ok(registration.body.csrfToken)
    assert.match(registration.headers['set-cookie'][0], /ec_session=/)
    assert.match(registration.headers['set-cookie'][0], /HttpOnly/i)
    assert.match(registration.headers['set-cookie'][0], /SameSite=Lax/i)

    const restored = await browser.get('/api/auth/session')
    assert.equal(restored.status, 200)
    assert.equal(restored.body.user.email, 'cookie-session@example.com')
    assert.equal(restored.body.csrfToken, registration.body.csrfToken)
    assert.match(restored.headers['cache-control'], /no-store/)

    const missingOrigin = await browser.put('/api/member/profile')
      .set('X-CSRF-Token', registration.body.csrfToken)
      .send({ name: 'Cookie Session User' })
    assert.equal(missingOrigin.status, 403)

    const missingCsrf = await browser.put('/api/member/profile')
      .set('Origin', process.env.CLIENT_URL)
      .send({ name: 'Cookie Session User' })
    assert.equal(missingCsrf.status, 403)

    const profile = await browser.put('/api/member/profile')
      .set('Origin', process.env.CLIENT_URL)
      .set('X-CSRF-Token', registration.body.csrfToken)
      .send({ name: 'Cookie Session User' })
    assert.equal(profile.status, 200, JSON.stringify(profile.body))

    const logout = await browser.post('/api/auth/logout')
      .set('Origin', process.env.CLIENT_URL)
      .set('X-CSRF-Token', registration.body.csrfToken)
    assert.equal(logout.status, 200)
    assert.match(logout.headers['set-cookie'][0], /ec_session=;/)
    assert.equal((await browser.get('/api/auth/session')).status, 401)
  } finally {
    process.env.EXPOSE_AUTH_TOKEN_FOR_TESTS = previousExposure
  }
})

test('registration and profile APIs reject invalid identity fields', async () => {
  const invalidName = await request(app).post('/api/auth/register').send({
    name: 'User 123',
    email: 'invalid-name@example.com',
    phone: '+923001234567',
    password: 'test-pass-123',
  })
  assert.equal(invalidName.status, 400)
  assert.ok(invalidName.body.errors.name)

  const invalidPhone = await request(app).post('/api/auth/register').send({
    name: 'Valid User',
    email: 'invalid-phone@example.com',
    phone: '+92ABC1234567',
    password: 'test-pass-123',
  })
  assert.equal(invalidPhone.status, 400)
  assert.ok(invalidPhone.body.errors.phone)

  const token = await customerToken()
  const profile = await request(app)
    .put('/api/member/profile')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Customer 99', cnic: '3520A-1234567-1' })
  assert.equal(profile.status, 400)
  assert.ok(profile.body.errors.name)
  assert.ok(profile.body.errors.cnic)
})

test('used car listing endpoint returns stored marketplace data', async () => {
  await Product.create({ make: 'Toyota', model: 'Corolla', year: 2021, km: 42000, price: 4500000 })
  const response = await request(app).get('/api/products?make=Toyota')
  assert.equal(response.status, 200)
  assert.equal(response.body.length, 1)
  assert.equal(response.body[0].model, 'Corolla')
})

test('auction inventory requires active membership and returns an approved DTO', async () => {
  const inactiveToken = await inactiveCustomerToken()
  const activeToken = await customerToken()
  const otherBidder = await Member.create({
    name: 'Private Bidder', email: 'private-bidder@example.com', phone: '+92 300 7654399', password: 'test-pass-123',
  })
  const car = await Car.create({
    make: 'Toyota', model: 'Corolla', year: 2020, km: 50000, engine: '1800', basePrice: 4000000,
    currentBid: 4100000, highestBidder: otherBidder._id, bidCount: 1,
    ownerId: otherBidder._id, sellerEmail: 'seller-private@example.com', demoKey: 'private-internal-key',
    auctionStart: new Date(Date.now() - 60000), auctionEnd: new Date(Date.now() + 3600000),
  })

  const anonymousList = await request(app).get('/api/cars?phase=all')
  const inactiveList = await request(app).get('/api/cars?phase=all').set('Authorization', `Bearer ${inactiveToken}`)
  assert.equal(anonymousList.status, 401)
  assert.equal(inactiveList.status, 403)

  const activeList = await request(app).get('/api/cars?phase=all').set('Authorization', `Bearer ${activeToken}`)
  assert.equal(activeList.status, 200)
  assert.equal(activeList.body.length, 1)
  assert.equal(activeList.body[0].model, 'Corolla')
  assert.equal(activeList.body[0].highestBidder.name, 'Pr***')
  assert.equal(activeList.body[0].highestBidder._id, undefined)
  for (const forbidden of ['ownerId', 'sellerEmail', 'demoKey']) {
    assert.equal(activeList.body[0][forbidden], undefined)
  }

  const anonymousDetail = await request(app).get(`/api/cars/${car._id}`)
  const inactiveDetail = await request(app).get(`/api/cars/${car._id}`).set('Authorization', `Bearer ${inactiveToken}`)
  const activeDetail = await request(app).get(`/api/cars/${car._id}`).set('Authorization', `Bearer ${activeToken}`)
  assert.equal(anonymousDetail.status, 401)
  assert.equal(inactiveDetail.status, 403)
  assert.equal(activeDetail.status, 200)
  assert.equal(activeDetail.body.sellerEmail, undefined)
})

test('private documents require authorization and short-lived access links', async () => {
  const ownerRegistration = await request(app).post('/api/auth/register').send({
    name: 'Document Owner', email: 'document-owner@example.com', phone: '+92 300 1112233', password: 'test-pass-123',
  })
  const otherRegistration = await request(app).post('/api/auth/register').send({
    name: 'Other Document User', email: 'other-document@example.com', phone: '+92 300 1112244', password: 'test-pass-123',
  })
  await Member.findByIdAndUpdate(ownerRegistration.body.user.id, { subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 86400000) })
  await Member.findByIdAndUpdate(otherRegistration.body.user.id, { subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 86400000) })

  const admin = await Admin.create({ name: 'Document Admin', email: 'document-admin@example.com', password: 'admin-pass-123', role: 'admin' })
  const adminLogin = await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })
  const ownerAuth = { Authorization: `Bearer ${ownerRegistration.body.token}` }
  const otherAuth = { Authorization: `Bearer ${otherRegistration.body.token}` }
  const adminAuth = { Authorization: `Bearer ${adminLogin.body.token}` }

  const key = `document-test-${Date.now()}.pdf`
  const bytes = Buffer.from('%PDF-1.4\nsynthetic QA document\n%%EOF')
  await fs.mkdir(privateUploadDir, { recursive: true })
  await fs.writeFile(path.join(privateUploadDir, key), bytes)
  const asset = { provider: 'local', key, resourceType: 'raw', contentType: 'application/pdf', size: bytes.length, extension: '.pdf' }

  try {
    const product = await Product.create({
      make: 'Honda', model: 'City', year: 2022, km: 21000, price: 5200000,
      ownerId: ownerRegistration.body.user.id, inspectionDocument: asset,
    })
    const booking = await Booking.create({
      memberId: ownerRegistration.body.user.id,
      name: 'Document Owner', email: 'document-owner@example.com', phone: '+923001112233',
      carMake: 'Honda', carModel: 'City', date: '2026-09-15', branch: 'Rawalpindi',
      cnicDocument: asset,
    })

    const publicProduct = await request(app).get(`/api/products/${product._id}`)
    assert.equal(publicProduct.status, 200)
    assert.equal(publicProduct.body.hasInspectionReport, true)
    assert.equal(publicProduct.body.inspectionDocument, undefined)
    assert.equal(publicProduct.body.pdfUrl, undefined)
    assert.equal(publicProduct.body.inspectionReportAccessPath, `/documents/products/${product._id}/report`)

    const anonymous = await request(app).get(`/api/documents/products/${product._id}/report`)
    assert.equal(anonymous.status, 401)

    const productAccess = await request(app).get(`/api/documents/products/${product._id}/report`).set(otherAuth)
    assert.equal(productAccess.status, 200)
    assert.match(productAccess.headers['cache-control'], /no-store/)
    assert.ok(new Date(productAccess.body.expiresAt) > new Date())
    const documentPath = new URL(productAccess.body.url).pathname
    const documentResponse = await request(app).get(documentPath)
    assert.equal(documentResponse.status, 200)
    assert.equal(documentResponse.headers['content-type'], 'application/pdf')
    assert.deepEqual(documentResponse.body, bytes)

    const wrongOwner = await request(app).get(`/api/documents/bookings/${booking._id}/cnic`).set(otherAuth)
    const correctOwner = await request(app).get(`/api/documents/bookings/${booking._id}/cnic`).set(ownerAuth)
    const adminAccess = await request(app).get(`/api/documents/bookings/${booking._id}/cnic`).set(adminAuth)
    assert.equal(wrongOwner.status, 403)
    assert.equal(correctOwner.status, 200)
    assert.equal(adminAccess.status, 200)

    const directLegacyPath = await request(app).get(`/uploads/${key}`)
    assert.equal(directLegacyPath.status, 404)

    const expiredPayload = Buffer.from(JSON.stringify({ key, contentType: 'application/pdf', extension: '.pdf', exp: 1 })).toString('base64url')
    const expiredSignature = crypto.createHmac('sha256', process.env.JWT_SECRET).update(expiredPayload).digest('base64url')
    const expired = await request(app).get(`/api/documents/access/${expiredPayload}.${expiredSignature}`)
    assert.equal(expired.status, 403)

    const renamedExecutable = await request(app)
      .post('/api/admin/products')
      .set(adminAuth)
      .field('make', 'Toyota').field('model', 'Yaris').field('year', '2022').field('km', '20000').field('price', '4900000')
      .attach('report', Buffer.from('MZ executable content'), { filename: 'report.pdf', contentType: 'application/pdf' })
    assert.equal(renamedExecutable.status, 400)
    assert.match(renamedExecutable.body.message, /does not match/i)
  } finally {
    await fs.unlink(path.join(privateUploadDir, key)).catch(() => {})
  }
})

test('upload boundaries reject unsafe counts and sizes and clean files after controller rejection', async () => {
  const admin = await Admin.create({ name: 'Upload Admin', email: 'upload-admin@example.com', password: 'admin-pass-123', role: 'admin' })
  const login = await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })
  const auth = { Authorization: `Bearer ${login.body.token}` }
  const publicImageDir = require('../src/config/cloudinary').publicImageDir
  await fs.mkdir(privateUploadDir, { recursive: true })
  await fs.mkdir(publicImageDir, { recursive: true })
  const privateBefore = await directoryNames(privateUploadDir)
  const publicBefore = await directoryNames(publicImageDir)
  const pdf = Buffer.from('%PDF-1.4\nsynthetic upload boundary fixture\n%%EOF')
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')])

  const rejectedAfterUpload = await request(app)
    .post('/api/admin/products')
    .set(auth)
    .field('model', 'Missing required make')
    .attach('report', pdf, { filename: 'synthetic.pdf', contentType: 'application/pdf' })
  assert.equal(rejectedAfterUpload.status, 400)
  await waitForDirectory(privateUploadDir, privateBefore)

  const oversized = await request(app)
    .post('/api/admin/products')
    .set(auth)
    .field('make', 'Honda').field('model', 'City').field('year', '2022').field('km', '10000').field('price', '5000000')
    .attach('report', Buffer.alloc(10 * 1024 * 1024 + 1, 0x25), { filename: 'too-large.pdf', contentType: 'application/pdf' })
  assert.equal(oversized.status, 413)
  await waitForDirectory(privateUploadDir, privateBefore)

  let excessRequest = request(app)
    .post('/api/admin/products')
    .set(auth)
    .field('make', 'Honda').field('model', 'City').field('year', '2022').field('km', '10000').field('price', '5000000')
  for (let index = 0; index < 7; index += 1) {
    excessRequest = excessRequest.attach('images', png, { filename: `image-${index}.png`, contentType: 'image/png' })
  }
  const excess = await excessRequest
  assert.equal(excess.status, 400)
  await waitForDirectory(publicImageDir, publicBefore)
})

test('customer cannot access administrator routes', async () => {
  const token = await customerToken()
  const response = await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${token}`)
  assert.equal(response.status, 403)
})

test('inspection booking requires a member account and remains owned by that member', async () => {
  const unauthenticatedOtp = await request(app)
    .post('/api/bookings/send-otp')
    .send({ email: 'customer@example.com' })
  assert.equal(unauthenticatedOtp.status, 401)

  const unauthenticatedBooking = await request(app)
    .post('/api/bookings')
    .send({ name: 'Visitor' })
  assert.equal(unauthenticatedBooking.status, 401)

  const memberToken = await customerToken()
  const memberAuth = { Authorization: `Bearer ${memberToken}` }

  await Admin.create({
    name: 'Test Administrator',
    email: 'admin-bookings@example.com',
    password: 'admin-pass-123',
    role: 'admin',
  })
  const adminLogin = await request(app).post('/api/auth/admin/login').send({
    email: 'admin-bookings@example.com',
    password: 'admin-pass-123',
  })
  assert.equal(adminLogin.status, 200)
  const adminAuth = { Authorization: `Bearer ${adminLogin.body.token}` }

  const adminOtp = await request(app)
    .post('/api/bookings/send-otp')
    .set(adminAuth)
    .send({ email: 'admin-bookings@example.com' })
  assert.equal(adminOtp.status, 403)

  const mismatchedEmail = await request(app)
    .post('/api/bookings/send-otp')
    .set(memberAuth)
    .send({ email: 'someone-else@example.com' })
  assert.equal(mismatchedEmail.status, 403)

  const otpResponse = await request(app)
    .post('/api/bookings/send-otp')
    .set(memberAuth)
    .send({ email: 'customer@example.com' })
  assert.equal(otpResponse.status, 200)
  assert.match(otpResponse.body.devOtp, /^\d{6}$/)

  const verification = await request(app)
    .post('/api/bookings/verify-otp')
    .set(memberAuth)
    .send({ email: 'customer@example.com', otp: otpResponse.body.devOtp })
  assert.equal(verification.status, 200)

  const invalidBooking = await request(app)
    .post('/api/bookings')
    .set(memberAuth)
    .send({
      name: 'Test Customer 7',
      email: 'customer@example.com',
      phone: '+92ABC123',
      cnic: '3520A-1234567-1',
      carMake: 'Honda',
      carModel: 'Civic',
      carYear: '20XX',
      mileage: '45km',
      engineCC: '1e3',
      date: new Date(Date.now() + 172800000).toISOString().slice(0, 10),
      branch: 'Islamabad Showroom',
    })
  assert.equal(invalidBooking.status, 400)
  assert.ok(invalidBooking.body.errors.name)
  assert.ok(invalidBooking.body.errors.phone)
  assert.ok(invalidBooking.body.errors.cnic)
  assert.ok(invalidBooking.body.errors.carYear)

  const date = new Date()
  date.setDate(date.getDate() + 2)
  const bookingResponse = await request(app)
    .post('/api/bookings')
    .set(memberAuth)
    .send({
      name: 'Test Customer',
      email: 'customer@example.com',
      phone: '+92 300 1234567',
      carMake: 'Honda',
      carModel: 'Civic',
      carYear: '2021',
      mileage: '45000',
      engineCC: '1800',
      date: date.toISOString().slice(0, 10),
      time: '10:00 AM - 12:00 PM',
      branch: 'Islamabad Showroom',
    })
  assert.equal(bookingResponse.status, 201)

  const duplicateBooking = await request(app)
    .post('/api/bookings')
    .set(memberAuth)
    .send({
      name: 'Test Customer', email: 'customer@example.com', phone: '+92 300 1234567',
      carMake: 'Honda', carModel: 'Civic', carYear: '2021', mileage: '45000', engineCC: '1800',
      date: date.toISOString().slice(0, 10), time: '10:00 AM - 12:00 PM', branch: 'Islamabad Showroom',
    })
  assert.equal(duplicateBooking.status, 409)

  const account = await Member.findOne({ email: 'customer@example.com' })
  const storedBooking = await Booking.findById(bookingResponse.body.bookingId)
  assert.equal(String(storedBooking.memberId), String(account._id))

  const ownedBookings = await request(app).get('/api/seller/bookings').set(memberAuth)
  assert.equal(ownedBookings.status, 200)
  assert.equal(ownedBookings.body.length, 1)

  const other = await request(app).post('/api/auth/register').send({
    name: 'Other Customer',
    email: 'other-booking@example.com',
    phone: '+92 300 5555555',
    password: 'test-pass-123',
  })
  const otherBookings = await request(app)
    .get('/api/seller/bookings')
    .set('Authorization', `Bearer ${other.body.token}`)
  assert.equal(otherBookings.status, 200)
  assert.equal(otherBookings.body.length, 0)

  const adminBookings = await request(app).get('/api/admin/bookings').set(adminAuth)
  assert.equal(adminBookings.status, 200)
  assert.equal(adminBookings.body.length, 1)

  const updated = await request(app)
    .patch(`/api/admin/bookings/${bookingResponse.body.bookingId}`)
    .set(adminAuth)
    .send({ status: 'approved' })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.booking.status, 'approved')
})

test('saved cars persist per customer without requiring auction membership', async () => {
  const first = await request(app).post('/api/auth/register').send({
    name: 'Saved Cars User', email: 'saved@example.com', phone: '+92 300 7654321', password: 'test-pass-123',
  })
  const second = await request(app).post('/api/auth/register').send({
    name: 'Other User', email: 'other@example.com', phone: '+92 300 7654322', password: 'test-pass-123',
  })
  const product = await Product.create({ make: 'Toyota', model: 'Yaris', year: 2022, km: 18000, price: 4700000 })
  const firstAuth = { Authorization: `Bearer ${first.body.token}` }
  const secondAuth = { Authorization: `Bearer ${second.body.token}` }

  const saved = await request(app).post(`/api/member/saved-cars/${product._id}`).set(firstAuth)
  assert.equal(saved.status, 201)
  assert.equal(saved.body.saved, true)

  const firstList = await request(app).get('/api/member/saved-cars').set(firstAuth)
  const secondList = await request(app).get('/api/member/saved-cars').set(secondAuth)
  assert.equal(firstList.status, 200)
  assert.equal(firstList.body.cars.length, 1)
  assert.equal(firstList.body.cars[0].model, 'Yaris')
  assert.equal(secondList.body.cars.length, 0)

  const removed = await request(app).delete(`/api/member/saved-cars/${product._id}`).set(firstAuth)
  assert.equal(removed.status, 200)
  const empty = await request(app).get('/api/member/saved-cars').set(firstAuth)
  assert.equal(empty.body.cars.length, 0)
})

test('demo checkout activates only the authenticated member and persists annual auction access', async () => {
  const registration = await request(app).post('/api/auth/register').send({
    name: 'Checkout Member', email: 'checkout@example.com', phone: '+92 300 7654333', password: 'test-pass-123',
  })
  const unauthenticated = await request(app).post('/api/payments/demo-complete')
  assert.equal(unauthenticated.status, 401)

  const complete = await request(app).post('/api/payments/demo-complete').set('Authorization', `Bearer ${registration.body.token}`).send({
    subscriptionStatus: 'active', subscriptionExpiry: '2099-01-01', amount: 1,
  })
  assert.equal(complete.status, 201)
  assert.equal(complete.body.subscriptionStatus, 'active')
  assert.equal(complete.body.amount, 4999)
  assert.equal(complete.body.paymentMode, 'demo')
  const member = await Member.findById(registration.body.user.id)
  assert.equal(member.subscriptionStatus, 'active')
  assert.equal(member.subscriptionPlan, 'annual_auction_membership')
  assert.ok(member.subscriptionExpiry > new Date())
  assert.equal(await MembershipPayment.countDocuments({ memberId: member._id, paymentMode: 'demo', status: 'completed' }), 1)
  const duplicate = await request(app).post('/api/payments/demo-complete').set('Authorization', `Bearer ${registration.body.token}`)
  assert.equal(duplicate.status, 409)
})

test('demo and removed Stripe surfaces cannot activate in production mode', async () => {
  const registration = await request(app).post('/api/auth/register').send({
    name: 'Production Gate User', email: 'production-gate@example.com', phone: '+92 300 7654355', password: 'test-pass-123',
  })
  const auth = { Authorization: `Bearer ${registration.body.token}` }

  assert.equal((await request(app).post('/api/payments/create-checkout-session').set(auth)).status, 404)
  assert.equal((await request(app).get('/api/payments/verify-session?session_id=fake').set(auth)).status, 404)
  assert.equal((await request(app).post('/api/payments/webhook')).status, 404)

  const previousMode = process.env.APP_MODE
  const previousNodeEnv = process.env.NODE_ENV
  try {
    process.env.APP_MODE = 'production'
    process.env.NODE_ENV = 'production'
    const demoPayment = await request(app).post('/api/payments/demo-complete').set(auth)
    const demoAccounts = await request(app).get('/api/demo/accounts')
    assert.equal(demoPayment.status, 404)
    assert.equal(demoAccounts.status, 404)
  } finally {
    if (previousMode === undefined) delete process.env.APP_MODE
    else process.env.APP_MODE = previousMode
    process.env.NODE_ENV = previousNodeEnv
  }
})

test('unsafe production configuration is rejected before startup', () => {
  assert.throws(() => validateRuntimeConfig({
    APP_MODE: 'production', NODE_ENV: 'production', EMAIL_DELIVERY_MODE: 'development', ENABLE_DEMO_SEED: 'false',
    PAYMENT_MODE: 'disabled', JWT_SECRET: 'this-is-a-long-enough-production-secret', CLIENT_URL: 'https://cars.example',
  }), /development email/i)
  assert.throws(() => validateRuntimeConfig({
    APP_MODE: 'production', NODE_ENV: 'production', EMAIL_DELIVERY_MODE: 'smtp', ENABLE_DEMO_SEED: 'true',
    PAYMENT_MODE: 'disabled', JWT_SECRET: 'this-is-a-long-enough-production-secret', CLIENT_URL: 'https://cars.example',
  }), /demo data/i)
  assert.throws(() => validateRuntimeConfig({
    APP_MODE: 'production', NODE_ENV: 'production', EMAIL_DELIVERY_MODE: 'smtp', ENABLE_DEMO_SEED: 'false',
    PAYMENT_MODE: 'demo', JWT_SECRET: 'this-is-a-long-enough-production-secret', CLIENT_URL: 'https://cars.example',
  }), /demo membership/i)
  assert.throws(() => validateRuntimeConfig({
    APP_MODE: 'production', NODE_ENV: 'production', EMAIL_DELIVERY_MODE: 'smtp', ENABLE_DEMO_SEED: 'false',
    PAYMENT_MODE: 'disabled', JWT_SECRET: 'change-me', CLIENT_URL: 'http://localhost:5173',
  }), /JWT_SECRET/i)
  assert.deepEqual(validateRuntimeConfig({
    APP_MODE: 'production', NODE_ENV: 'production', EMAIL_DELIVERY_MODE: 'smtp', ENABLE_DEMO_SEED: 'false',
    PAYMENT_MODE: 'disabled', JWT_SECRET: 'this-is-a-long-enough-production-secret', CLIENT_URL: 'https://cars.example',
  }), { appMode: 'production', demo: false })
})

test('auction rejects negative, low, and closed bids and accepts a valid bid', async () => {
  const token = await customerToken()
  const car = await Car.create({
    make: 'Honda', model: 'Civic', year: 2020, km: 50000, engine: '1800', basePrice: 4000000,
    currentBid: 4000000, auctionStart: new Date(Date.now() - 60000), auctionEnd: new Date(Date.now() + 3600000),
  })
  const auth = { Authorization: `Bearer ${token}` }
  const negative = await request(app).post('/api/bids').set(auth).send({ carId: car._id, amount: -1 })
  assert.equal(negative.status, 400)
  const exponent = await request(app).post('/api/bids').set(auth).send({ carId: car._id, amount: '4.05e6' })
  assert.equal(exponent.status, 400)
  const low = await request(app).post('/api/bids').set(auth).send({ carId: car._id, amount: 4000001 })
  assert.equal(low.status, 400)
  const valid = await request(app).post('/api/bids').set(auth).send({ carId: car._id, amount: 4050000 })
  assert.equal(valid.status, 201)
  await Car.findByIdAndUpdate(car._id, { status: 'ended' })
  const closed = await request(app).post('/api/bids').set(auth).send({ carId: car._id, amount: 4100000 })
  assert.equal(closed.status, 400)
})

test('auction bidding requires authentication and an unexpired active membership', async () => {
  const registration = await request(app).post('/api/auth/register').send({
    name: 'Inactive Bidder', email: 'inactive-bidder@example.com', phone: '+92 300 7654344', password: 'test-pass-123',
  })
  const car = await Car.create({
    make: 'Suzuki', model: 'Swift', year: 2022, km: 30000, engine: '1200', basePrice: 3000000, currentBid: 3000000,
    auctionStart: new Date(Date.now() - 60000), auctionEnd: new Date(Date.now() + 3600000),
  })
  const unauthenticated = await request(app).post('/api/bids').send({ carId: car._id, amount: 3050000 })
  assert.equal(unauthenticated.status, 401)
  const inactive = await request(app).post('/api/bids').set('Authorization', `Bearer ${registration.body.token}`).send({ carId: car._id, amount: 3050000 })
  assert.equal(inactive.status, 403)
  assert.match(inactive.body.message, /active membership/i)
  await Member.findByIdAndUpdate(registration.body.user.id, { subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() - 1000) })
  const expired = await request(app).post('/api/bids').set('Authorization', `Bearer ${registration.body.token}`).send({ carId: car._id, amount: 3050000 })
  assert.equal(expired.status, 403)
})

test('only administrators can view bid history and close an auction', async () => {
  const memberToken = await customerToken()
  const member = await Member.findOne({ email: 'customer@example.com' })
  const admin = await Admin.create({
    name: 'Auction Administrator', email: 'admin-auctions@example.com', password: 'admin-pass-123', role: 'admin',
  })
  const adminLogin = await request(app).post('/api/auth/admin/login').send({
    email: admin.email, password: 'admin-pass-123',
  })
  assert.equal(adminLogin.status, 200)

  const auction = await Car.create({
    make: 'Toyota', model: 'Yaris', year: 2022, km: 12000, engine: '1500', basePrice: 3500000,
    currentBid: 3600000, highestBidder: member._id, bidCount: 1,
    auctionStart: new Date(Date.now() - 60000), auctionEnd: new Date(Date.now() + 3600000),
  })
  await Bid.create({ carId: auction._id, bidderId: member._id, amount: 3600000 })

  const memberResult = await request(app)
    .get(`/api/admin/cars/${auction._id}/results`)
    .set('Authorization', `Bearer ${memberToken}`)
  assert.equal(memberResult.status, 403)

  const result = await request(app)
    .get(`/api/admin/cars/${auction._id}/results`)
    .set('Authorization', `Bearer ${adminLogin.body.token}`)
  assert.equal(result.status, 200)
  assert.equal(result.body.bids.length, 1)
  assert.equal(result.body.auction.highestBidder.email, 'customer@example.com')

  const close = await request(app)
    .post(`/api/admin/cars/${auction._id}/close`)
    .set('Authorization', `Bearer ${adminLogin.body.token}`)
  assert.equal(close.status, 200)
  assert.equal(close.body.auction.status, 'ended')
  assert.equal(close.body.reserveMet, true)

  const secondClose = await request(app)
    .post(`/api/admin/cars/${auction._id}/close`)
    .set('Authorization', `Bearer ${adminLogin.body.token}`)
  assert.equal(secondClose.status, 409)

  const reserveAuction = await Car.create({
    make: 'Honda', model: 'City', year: 2021, km: 30000, engine: '1500', basePrice: 3200000,
    reservePrice: 4000000, currentBid: 3600000, highestBidder: member._id, bidCount: 1,
    auctionStart: new Date(Date.now() - 60000), auctionEnd: new Date(Date.now() + 3600000),
  })
  await Bid.create({ carId: reserveAuction._id, bidderId: member._id, amount: 3600000 })
  const reserveClose = await request(app)
    .post(`/api/admin/cars/${reserveAuction._id}/close`)
    .set('Authorization', `Bearer ${adminLogin.body.token}`)
  assert.equal(reserveClose.status, 200)
  assert.equal(reserveClose.body.reserveMet, false)

  const reserveResult = await request(app)
    .get(`/api/admin/cars/${reserveAuction._id}/results`)
    .set('Authorization', `Bearer ${adminLogin.body.token}`)
  assert.equal(reserveResult.status, 200)
  assert.equal(reserveResult.body.reserveMet, false)
  assert.equal(reserveResult.body.winner, null)

  const wonCars = await request(app).get('/api/member/won').set('Authorization', `Bearer ${memberToken}`)
  assert.equal(wonCars.status, 200)
  assert.ok(wonCars.body.every(car => car._id !== String(reserveAuction._id)))
})

test('dataset import requires administrator authorization', async () => {
  const token = await customerToken()
  const response = await request(app).post('/api/admin/dataset-imports').set('Authorization', `Bearer ${token}`)
  assert.equal(response.status, 403)
})

test('development demo seed is idempotent and its accounts enforce real roles', async () => {
  const first = await seedDemo()
  const second = await seedDemo()
  assert.equal(first.accounts, 4)
  assert.equal(second.cars, 5)
  assert.equal(await Member.countDocuments({ demoKey: { $regex: '^executive-cars-demo:' } }), 3)
  assert.equal(await Admin.countDocuments({ demoKey: { $regex: '^executive-cars-demo:' } }), 1)
  assert.equal(await Product.countDocuments({ demoKey: { $regex: '^executive-cars-demo:' } }), 5)
  assert.equal(await Car.countDocuments({ demoKey: { $regex: '^executive-cars-demo:' } }), 4)
  assert.equal(await Bid.countDocuments({ demoKey: { $regex: '^executive-cars-demo:' } }), 6)
  assert.equal(await Booking.countDocuments({ demoKey: { $regex: '^executive-cars-demo:' } }), 4)
  const seededPremium = await Member.findOne({ email: 'member@executivecars.pk' })
  assert.match(seededPremium.password, /^\$2[aby]\$/)
  assert.notEqual(seededPremium.password, 'Member@12345')
  assert.equal(seededPremium.membershipSource, 'demo')

  const premium = await request(app).post('/api/auth/login').send({ email: 'member@executivecars.pk', password: 'Member@12345' })
  const regular = await request(app).post('/api/auth/login').send({ email: 'user@executivecars.pk', password: 'User@12345' })
  const bidder = await request(app).post('/api/auth/login').send({ email: 'bidder@executivecars.pk', password: 'Bidder@12345' })
  const adminLogin = await request(app).post('/api/auth/admin/login').send({ email: 'admin@executivecars.pk', password: 'Admin@12345' })
  assert.equal(premium.status, 200)
  assert.equal(premium.body.user.capabilities.auction, true)
  assert.equal(regular.status, 200)
  assert.equal(regular.body.user.capabilities.auction, false)
  assert.equal(bidder.status, 200)
  assert.equal(adminLogin.status, 200)
  assert.equal(adminLogin.body.user.role, 'admin')

  const premiumStats = await request(app).get('/api/member/stats').set('Authorization', `Bearer ${premium.body.token}`)
  const blockedRegular = await request(app).get('/api/member/stats').set('Authorization', `Bearer ${regular.body.token}`)
  const adminStats = await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${adminLogin.body.token}`)
  assert.equal(premiumStats.status, 200)
  assert.equal(blockedRegular.status, 403)
  assert.equal(adminStats.status, 200)
  assert.equal(adminStats.body.totalMembers, 3)

  const verifiedOtp = await request(app).post('/api/bookings/verify-otp')
    .set('Authorization', `Bearer ${premium.body.token}`)
    .send({ email: 'member@executivecars.pk', otp: DEMO_OTP })
  assert.equal(verifiedOtp.status, 200)
})
