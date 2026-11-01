process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'development'
process.env.ENABLE_DEMO_SEED = 'true'
process.env.EXPOSE_AUTH_TOKEN_FOR_TESTS = 'true'
process.env.ENABLE_HOSTED_DEMO_MEMBERSHIP = 'false'
const { DEFAULT_TEST_URI, validateTestUri, connectTestDatabase, dropTestDatabase, resetTestDatabase } = require('./helpers/localDatabase')
process.env.MONGO_URI = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GROQ_API_KEY', 'ML_SERVICE_KEY', 'RESEND_API_KEY']) process.env[key] = ''

const { before, after, beforeEach, afterEach, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const axios = require('axios')
const mongoose = require('mongoose')
const request = require('supertest')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const Member = require('../src/models/Member')
const Seller = require('../src/models/Seller')
const Session = require('../src/models/Session')
const PasswordResetToken = require('../src/models/PasswordResetToken')
const email = require('../src/utils/email')
const throttle = require('../src/utils/loginThrottle')
const { MAX_REQUESTS, WINDOW_MS, consumeResetRequest } = require('../src/utils/resetRequests')

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

// Mail is captured instead of sent. Delivery mode "smtp" keeps the development-only reset link out of the
// response, which is what a real deployment looks like.
const original = { reset: email.sendPasswordResetEmail, changed: email.sendPasswordChangedEmail, mode: process.env.EMAIL_DELIVERY_MODE }
let resetMails
let changedMails
beforeEach(async () => {
  await resetTestDatabase()
  resetMails = []
  changedMails = []
  process.env.EMAIL_DELIVERY_MODE = 'smtp'
  email.sendPasswordResetEmail = async (to, url) => { resetMails.push({ to, url, token: new URL(url).searchParams.get('token') }) }
  email.sendPasswordChangedEmail = async (to, details) => { changedMails.push({ to, ...details }) }
})
afterEach(() => {
  email.sendPasswordResetEmail = original.reset
  email.sendPasswordChangedEmail = original.changed
  process.env.EMAIL_DELIVERY_MODE = original.mode
})

const customer = { name: 'Reset Customer', email: 'reset-customer@example.com', phone: '+92 300 5550201', password: 'orchid-lantern-42' }
const makeMember = () => Member.create(customer)
const makeAdmin = () => Admin.create({ name: 'Reset Admin', email: 'reset-admin@example.com', password: 'admin-pass-123', role: 'admin' })
const forgot = address => request(app).post('/api/auth/forgot-password').send({ email: address })
const reset = (token, password) => request(app).post('/api/auth/reset-password').send({ token, password })
const requestLink = async address => {
  const before = resetMails.length
  const response = await forgot(address)
  assert.equal(response.status, 200)
  assert.equal(resetMails.length, before + 1, 'a reset email should have been handed to the mailer')
  return resetMails.at(-1).token
}

describe('requesting a reset', () => {
  test('answers identically for a registered and an unknown address', async () => {
    await makeMember()
    const known = await forgot(customer.email)
    const unknown = await forgot('nobody-here@example.com')
    assert.equal(known.status, 200)
    assert.equal(unknown.status, 200)
    assert.deepEqual(known.body, unknown.body)
    assert.equal(resetMails.length, 1)
    assert.equal(resetMails[0].to, customer.email)
  })

  test('works for administrators and legacy sellers, not only customers', async () => {
    const admin = await makeAdmin()
    const seller = await Seller.create({ name: 'Old Seller', email: 'old-seller@example.com', password: 'seller-pass-123' })
    await forgot(admin.email)
    await forgot(seller.email)
    const records = await PasswordResetToken.find().lean()
    assert.deepEqual(records.map(record => record.accountModel).sort(), ['admin', 'seller'])
    assert.deepEqual(resetMails.map(mail => mail.to).sort(), [admin.email, seller.email].sort())
  })

  test('a customer account wins when the same address also exists as an administrator', async () => {
    await makeMember()
    await Admin.create({ name: 'Same Address', email: customer.email, password: 'admin-pass-123', role: 'admin' })
    await forgot(customer.email)
    assert.equal((await PasswordResetToken.findOne()).accountModel, 'member')
  })

  test('rejects a malformed address with a field error', async () => {
    const response = await forgot('not-an-email')
    assert.equal(response.status, 400)
    assert.ok(response.body.errors.email)
  })

  test('a new request replaces the link that is still outstanding', async () => {
    await makeMember()
    const first = await requestLink(customer.email)
    const second = await requestLink(customer.email)
    assert.equal(await PasswordResetToken.countDocuments(), 1)
    assert.equal((await reset(first, 'violet-harbour-77')).status, 400)
    assert.equal((await reset(second, 'violet-harbour-77')).status, 200)
  })

  test(`each account may request ${MAX_REQUESTS} links an hour; more are answered the same but send nothing`, async () => {
    await makeMember()
    await Member.create({ ...customer, email: 'someone-else@example.com', phone: '+92 300 5550202' })
    for (let i = 0; i < MAX_REQUESTS; i += 1) await forgot(customer.email)
    assert.equal(resetMails.length, MAX_REQUESTS)
    const over = await forgot(customer.email)
    assert.equal(over.status, 200)
    assert.deepEqual(over.body, (await forgot('nobody-here@example.com')).body)
    assert.equal(resetMails.length, MAX_REQUESTS, 'the capped request must not send an email')
    await forgot('someone-else@example.com')
    assert.equal(resetMails.length, MAX_REQUESTS + 1, 'another account is not affected')
  })

  test('the hourly allowance starts again once the hour is over', async () => {
    const id = new mongoose.Types.ObjectId()
    const T0 = 1_800_000_000_000
    for (let i = 0; i < MAX_REQUESTS; i += 1) assert.equal(await consumeResetRequest('member', id, T0 + i), true)
    assert.equal(await consumeResetRequest('member', id, T0 + 10), false)
    assert.equal(await consumeResetRequest('member', id, T0 + WINDOW_MS + 1000), true)
  })

  test('a failing mail provider never changes the answer', async () => {
    await makeMember()
    email.sendPasswordResetEmail = async () => { throw new Error('provider down') }
    const failing = await forgot(customer.email)
    const unknown = await forgot('nobody-here@example.com')
    assert.equal(failing.status, 200)
    assert.deepEqual(failing.body, unknown.body)
    email.sendPasswordResetEmail = () => { throw new Error('synchronous failure') }
    assert.equal((await forgot(customer.email)).status, 200)
  })

  test('the development reset link is only returned in local demo delivery', async () => {
    await makeMember()
    process.env.EMAIL_DELIVERY_MODE = 'development'
    const local = await forgot(customer.email)
    assert.match(local.body.developmentResetUrl, /\/reset-password\?token=[a-f0-9]{64}$/)
    process.env.EMAIL_DELIVERY_MODE = 'smtp'
    assert.equal((await forgot(customer.email)).body.developmentResetUrl, undefined)
  })
})

describe('completing a reset', () => {
  test('a customer resets, signs in with the new password and the old one stops working', async () => {
    await makeMember()
    const token = await requestLink(customer.email)
    const done = await reset(token, 'violet-harbour-77')
    assert.equal(done.status, 200)
    assert.equal((await request(app).post('/api/auth/login').send({ email: customer.email, password: 'violet-harbour-77' })).status, 200)
    assert.equal((await request(app).post('/api/auth/login').send({ email: customer.email, password: customer.password })).status, 401)
  })

  test('an administrator resets, loses every session, and can sign in only with the new password', async () => {
    const admin = await makeAdmin()
    const signedIn = await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })
    assert.equal(signedIn.status, 200)
    const auth = { Authorization: `Bearer ${signedIn.body.token}` }
    assert.equal((await request(app).get('/api/auth/session').set(auth)).status, 200)

    const token = await requestLink(admin.email)
    assert.equal((await reset(token, 'harbour-violet-88')).status, 200)

    const after = await request(app).get('/api/auth/session').set(auth)
    assert.equal(after.status, 401)
    assert.equal(after.body.code, 'SESSION_REVOKED')
    assert.equal((await Session.countDocuments({ accountModel: 'admin', revokedAt: null })), 0)
    assert.equal((await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })).status, 401)
    assert.equal((await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'harbour-violet-88' })).status, 200)
  })

  test('a legacy seller resets and then signs in through the unified form', async () => {
    const seller = await Seller.create({ name: 'Old Seller', email: 'old-seller@example.com', password: 'seller-pass-123' })
    const token = await requestLink(seller.email)
    assert.equal((await reset(token, 'meadow-amber-31')).status, 200)
    const login = await request(app).post('/api/auth/login').send({ email: seller.email, password: 'meadow-amber-31' })
    assert.equal(login.status, 200)
    assert.equal(login.body.user.sellerApproved, true)
  })

  test('the link works once, expires, and an unknown or malformed token is refused', async () => {
    await makeMember()
    const token = await requestLink(customer.email)
    assert.equal((await reset(token, 'violet-harbour-77')).status, 200)
    assert.equal((await reset(token, 'another-pass-99')).status, 400)

    const expiredToken = crypto.randomBytes(32).toString('hex')
    await PasswordResetToken.create({
      accountId: (await Member.findOne())._id, tokenHash: crypto.createHash('sha256').update(expiredToken).digest('hex'), expiresAt: new Date(Date.now() - 1000),
    })
    assert.equal((await reset(expiredToken, 'another-pass-99')).status, 400)
    assert.equal((await reset(crypto.randomBytes(32).toString('hex'), 'another-pass-99')).status, 400)
    assert.equal((await reset('short', 'another-pass-99')).status, 400)
  })

  test('a link for an account that no longer exists is refused', async () => {
    const member = await makeMember()
    const token = await requestLink(customer.email)
    await Member.deleteOne({ _id: member._id })
    assert.equal((await reset(token, 'violet-harbour-77')).status, 400)
  })

  test('a weak password is rejected and the link keeps working', async () => {
    await makeMember()
    const token = await requestLink(customer.email)
    const weak = await reset(token, 'letmein123')
    assert.equal(weak.status, 400)
    assert.ok(weak.body.errors.password)
    assert.equal((await reset(token, 'violet-harbour-77')).status, 200)
  })

  test('resetting clears the sign-in delay so the owner can get straight back in', async () => {
    await makeMember()
    for (let i = 0; i < 25; i += 1) await throttle.recordFailure('member', { ip: `198.51.100.${i}`, email: customer.email })
    assert.ok(await throttle.check('member', { ip: '192.0.2.1', email: customer.email }) > 0)
    const token = await requestLink(customer.email)
    await reset(token, 'violet-harbour-77')
    assert.equal(await throttle.check('member', { ip: '192.0.2.1', email: customer.email }), 0)
    assert.equal((await request(app).post('/api/auth/login').send({ email: customer.email, password: 'violet-harbour-77' })).status, 200)
  })

  test('old records with an unrelated invalid field can still reset and change their password', async () => {
    const member = await makeMember()
    await Member.collection.updateOne({ _id: member._id }, { $set: { phone: 'not-a-phone', cnic: 'bad' } })
    const token = await requestLink(customer.email)
    assert.equal((await reset(token, 'violet-harbour-77')).status, 200)
    const signedIn = await request(app).post('/api/auth/login').send({ email: customer.email, password: 'violet-harbour-77' })
    const change = await request(app).post('/api/auth/change-password').set({ Authorization: `Bearer ${signedIn.body.token}` })
      .send({ current: 'violet-harbour-77', newPassword: 'amber-meadow-58' })
    assert.equal(change.status, 200)
  })

  test('resetting does not depend on the confirmation email being delivered', async () => {
    await makeMember()
    const token = await requestLink(customer.email)
    email.sendPasswordChangedEmail = async () => { throw new Error('provider down') }
    assert.equal((await reset(token, 'violet-harbour-77')).status, 200)
  })
})

describe('password-changed notification', () => {
  test('is sent after a reset and after a change from the account settings, to the account address', async () => {
    const member = await makeMember()
    const token = await requestLink(customer.email)
    await reset(token, 'violet-harbour-77')
    assert.deepEqual(changedMails, [{ to: customer.email, name: customer.name, reason: 'reset' }])

    const signedIn = await request(app).post('/api/auth/login').send({ email: customer.email, password: 'violet-harbour-77' })
    const change = await request(app).post('/api/auth/change-password').set({ Authorization: `Bearer ${signedIn.body.token}` })
      .send({ current: 'violet-harbour-77', newPassword: 'amber-meadow-58' })
    assert.equal(change.status, 200)
    assert.equal(changedMails.length, 2)
    assert.deepEqual(changedMails[1], { to: member.email, name: customer.name, reason: 'change' })
  })

  test('is not sent when the change was refused', async () => {
    await makeMember()
    const signedIn = await request(app).post('/api/auth/login').send({ email: customer.email, password: customer.password })
    const auth = { Authorization: `Bearer ${signedIn.body.token}` }
    await request(app).post('/api/auth/change-password').set(auth).send({ current: 'wrong-current-1', newPassword: 'amber-meadow-58' })
    await request(app).post('/api/auth/change-password').set(auth).send({ current: customer.password, newPassword: 'password123' })
    assert.equal(changedMails.length, 0)
  })

  test('a failing mail provider does not fail the password change', async () => {
    await makeMember()
    const signedIn = await request(app).post('/api/auth/login').send({ email: customer.email, password: customer.password })
    email.sendPasswordChangedEmail = async () => { throw new Error('provider down') }
    const change = await request(app).post('/api/auth/change-password').set({ Authorization: `Bearer ${signedIn.body.token}` })
      .send({ current: customer.password, newPassword: 'amber-meadow-58' })
    assert.equal(change.status, 200)
  })

  test('the email names the account and how it changed, escapes the name and points at the reset page', async t => {
    const previous = { mode: process.env.EMAIL_DELIVERY_MODE, key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL }
    process.env.EMAIL_DELIVERY_MODE = 'resend'
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.RESEND_FROM_EMAIL = 'no-reply@account.example.com'
    const originalPost = axios.post
    const sent = []
    axios.post = async (url, payload) => { sent.push(payload); return { data: { id: 'email-id' } } }
    t.after(() => {
      axios.post = originalPost
      process.env.EMAIL_DELIVERY_MODE = previous.mode
      process.env.RESEND_API_KEY = previous.key
      process.env.RESEND_FROM_EMAIL = previous.from
    })
    await original.changed('member@example.com', { name: '<script>alert(1)</script>', reason: 'reset', at: new Date('2026-11-01T10:00:00Z') })
    assert.deepEqual(sent[0].to, ['member@example.com'])
    assert.equal(sent[0].subject, 'Your Executive Cars password was changed')
    assert.match(sent[0].html, /using a password reset link/)
    assert.match(sent[0].html, /Sun, 01 Nov 2026 10:00:00 GMT/)
    assert.match(sent[0].html, /http:\/\/127\.0\.0\.1:5173\/forgot-password/)
    assert.ok(!sent[0].html.includes('<script>'))
    assert.match(sent[0].html, /&lt;script&gt;/)
    await original.changed('member@example.com', { name: 'Someone', reason: 'change' })
    assert.match(sent[1].html, /from your account settings/)
  })
})
