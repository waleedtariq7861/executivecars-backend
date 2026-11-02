process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'development'
process.env.ENABLE_DEMO_SEED = 'true'
const { DEFAULT_TEST_URI, validateTestUri, connectTestDatabase, dropTestDatabase, resetTestDatabase } = require('./helpers/localDatabase')
process.env.MONGO_URI = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GROQ_API_KEY', 'ML_SERVICE_KEY', 'RESEND_API_KEY']) process.env[key] = ''

const { before, after, beforeEach, afterEach, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const mongoose = require('mongoose')
require('./helpers/noRateLimits')
const request = require('supertest')
require('./helpers/cookieAuth')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const Member = require('../src/models/Member')
const Session = require('../src/models/Session')
const PasswordResetCode = require('../src/models/PasswordResetCode')
const email = require('../src/utils/email')
const throttle = require('../src/utils/loginThrottle')
const { MAX_REQUESTS, WINDOW_MS, consumeResetRequest } = require('../src/utils/resetRequests')
const { MAX_ATTEMPTS } = require('../src/utils/passwordResetCode')

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

// Mail is captured instead of sent. Delivery mode "smtp" keeps the development-only code out of the
// response, which is what a real deployment looks like.
const original = { reset: email.sendPasswordResetCodeEmail, changed: email.sendPasswordChangedEmail, mode: process.env.EMAIL_DELIVERY_MODE }
let resetMails
let changedMails
beforeEach(async () => {
  await resetTestDatabase()
  resetMails = []
  changedMails = []
  process.env.EMAIL_DELIVERY_MODE = 'smtp'
  email.sendPasswordResetCodeEmail = async (to, details) => { resetMails.push({ to, ...details }) }
  email.sendPasswordChangedEmail = async (to, details) => { changedMails.push({ to, ...details }) }
})
afterEach(() => {
  email.sendPasswordResetCodeEmail = original.reset
  email.sendPasswordChangedEmail = original.changed
  process.env.EMAIL_DELIVERY_MODE = original.mode
})

const customer = { name: 'Reset Customer', email: 'reset-customer@example.com', phone: '+92 300 5550201', password: 'orchid-lantern-42' }
const makeMember = () => Member.create(customer)
const makeAdmin = () => Admin.create({ name: 'Reset Admin', email: 'reset-admin@example.com', password: 'admin-pass-123', role: 'admin' })
const forgot = address => request(app).post('/api/auth/forgot-password').send({ email: address })
const reset = (address, code, password) => request(app).post('/api/auth/reset-password').send({ email: address, code, password })
const requestCode = async address => {
  const before = resetMails.length
  const response = await forgot(address)
  assert.equal(response.status, 200)
  assert.equal(resetMails.length, before + 1, 'a reset email should have been handed to the mailer')
  return resetMails.at(-1).code
}
const wrongCodeFor = code => (code === '000000' ? '000001' : '000000')

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
    assert.equal(resetMails[0].name, customer.name)
    assert.match(resetMails[0].code, /^\d{6}$/)
  })

  test('stores a keyed digest, never the code itself', async () => {
    await makeMember()
    const code = await requestCode(customer.email)
    const record = await PasswordResetCode.findOne()
    assert.notEqual(record.otpDigest, code)
    assert.ok(!record.otpDigest.includes(code))
    assert.ok(record.expiresAt.getTime() - Date.now() <= 10 * 60 * 1000)
  })

  test('works for administrators, not only customers', async () => {
    const admin = await makeAdmin()
    await forgot(admin.email)
    assert.equal((await PasswordResetCode.findOne()).accountModel, 'admin')
    assert.deepEqual(resetMails.map(mail => mail.to), [admin.email])
  })

  test('a customer account wins when the same address also exists as an administrator', async () => {
    await makeMember()
    await Admin.create({ name: 'Same Address', email: customer.email, password: 'admin-pass-123', role: 'admin' })
    await forgot(customer.email)
    assert.equal((await PasswordResetCode.findOne()).accountModel, 'member')
  })

  test('rejects a malformed address with a field error', async () => {
    const response = await forgot('not-an-email')
    assert.equal(response.status, 400)
    assert.ok(response.body.errors.email)
  })

  test('a new request replaces the code that is still outstanding', async () => {
    await makeMember()
    const first = await requestCode(customer.email)
    const second = await requestCode(customer.email)
    assert.equal(await PasswordResetCode.countDocuments(), 1)
    if (first !== second) assert.equal((await reset(customer.email, first, 'violet-harbour-77')).status, 400)
    assert.equal((await reset(customer.email, second, 'violet-harbour-77')).status, 200)
  })

  test(`each account may request ${MAX_REQUESTS} codes an hour; more are answered the same but send nothing`, async () => {
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
    email.sendPasswordResetCodeEmail = async () => { throw new Error('provider down') }
    const failing = await forgot(customer.email)
    const unknown = await forgot('nobody-here@example.com')
    assert.equal(failing.status, 200)
    assert.deepEqual(failing.body, unknown.body)
    email.sendPasswordResetCodeEmail = () => { throw new Error('synchronous failure') }
    assert.equal((await forgot(customer.email)).status, 200)
  })

  test('the development code is only returned in local demo delivery', async () => {
    await makeMember()
    process.env.EMAIL_DELIVERY_MODE = 'development'
    const local = await forgot(customer.email)
    assert.equal(local.body.developmentCode, resetMails.at(-1).code)
    process.env.EMAIL_DELIVERY_MODE = 'smtp'
    assert.equal((await forgot(customer.email)).body.developmentCode, undefined)
  })
})

describe('completing a reset', () => {
  test('a customer resets, signs in with the new password and the old one stops working', async () => {
    await makeMember()
    const code = await requestCode(customer.email)
    const done = await reset(customer.email, code, 'violet-harbour-77')
    assert.equal(done.status, 200)
    assert.equal((await request(app).post('/api/auth/login').send({ email: customer.email, password: 'violet-harbour-77' })).status, 200)
    assert.equal((await request(app).post('/api/auth/login').send({ email: customer.email, password: customer.password })).status, 401)
  })

  test('the address is not case sensitive and spaces inside the code are ignored', async () => {
    await makeMember()
    const code = await requestCode(customer.email)
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
    assert.equal((await reset(customer.email.toUpperCase(), spaced, 'violet-harbour-77')).status, 200)
  })

  test('an administrator resets, loses every session, and can sign in only with the new password', async () => {
    const admin = await makeAdmin()
    const signedIn = await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })
    assert.equal(signedIn.status, 200)
    const auth = { Authorization: `Bearer ${signedIn.body.token}` }
    assert.equal((await request(app).get('/api/auth/session').set(auth)).status, 200)

    const code = await requestCode(admin.email)
    assert.equal((await reset(admin.email, code, 'harbour-violet-88')).status, 200)

    const after = await request(app).get('/api/auth/session').set(auth)
    assert.equal(after.status, 401)
    assert.equal(after.body.code, 'SESSION_REVOKED')
    assert.equal((await Session.countDocuments({ accountModel: 'admin', revokedAt: null })), 0)
    assert.equal((await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })).status, 401)
    assert.equal((await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'harbour-violet-88' })).status, 200)
  })

  test('the code works once and an expired code is refused', async () => {
    await makeMember()
    const code = await requestCode(customer.email)
    assert.equal((await reset(customer.email, code, 'violet-harbour-77')).status, 200)
    assert.equal((await reset(customer.email, code, 'another-pass-99')).status, 400)

    const next = await requestCode(customer.email)
    await PasswordResetCode.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal((await reset(customer.email, next, 'another-pass-99')).status, 400)
    assert.equal(await PasswordResetCode.countDocuments(), 0, 'an expired code is removed when it is tried')
  })

  test('a wrong code, an unknown address and a missing code all get the same answer', async () => {
    await makeMember()
    await makeAdmin()
    const code = await requestCode(customer.email)
    const wrong = await reset(customer.email, wrongCodeFor(code), 'violet-harbour-77')
    const unknown = await reset('nobody-here@example.com', code, 'violet-harbour-77')
    const none = await reset('reset-admin@example.com', code, 'violet-harbour-77')
    for (const response of [wrong, unknown, none]) {
      assert.equal(response.status, 400)
      assert.equal(response.body.code, 'RESET_CODE_INVALID')
    }
    assert.deepEqual(wrong.body, unknown.body)
    assert.deepEqual(wrong.body, none.body)
  })

  test('malformed input gets a field error, not a guess', async () => {
    await makeMember()
    assert.ok((await reset('not-an-email', '123456', 'violet-harbour-77')).body.errors.email)
    assert.ok((await reset(customer.email, '12345', 'violet-harbour-77')).body.errors.code)
    assert.ok((await reset(customer.email, 'abcdef', 'violet-harbour-77')).body.errors.code)
    assert.ok((await reset(customer.email, '123456', undefined)).body.errors.password)
  })

  test(`${MAX_ATTEMPTS} wrong guesses use the code up, even for the right code afterwards`, async () => {
    await makeMember()
    const code = await requestCode(customer.email)
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) assert.equal((await reset(customer.email, wrongCodeFor(code), 'violet-harbour-77')).status, 400)
    const late = await reset(customer.email, code, 'violet-harbour-77')
    assert.equal(late.status, 400)
    assert.equal(late.body.code, 'RESET_CODE_INVALID')
    assert.equal((await request(app).post('/api/auth/login').send({ email: customer.email, password: customer.password })).status, 200, 'the password did not change')
    const fresh = await requestCode(customer.email)
    assert.equal((await reset(customer.email, fresh, 'violet-harbour-77')).status, 200)
  })

  test('parallel guesses cannot exceed the attempt limit', async () => {
    await makeMember()
    const code = await requestCode(customer.email)
    await Promise.all(Array.from({ length: 12 }, () => reset(customer.email, wrongCodeFor(code), 'violet-harbour-77')))
    assert.equal((await PasswordResetCode.findOne()).attempts, MAX_ATTEMPTS)
    assert.equal((await reset(customer.email, code, 'violet-harbour-77')).status, 400)
  })

  test('a code only works for the address it was sent to', async () => {
    await makeMember()
    await Member.create({ ...customer, email: 'someone-else@example.com', phone: '+92 300 5550202' })
    const code = await requestCode(customer.email)
    assert.equal((await reset('someone-else@example.com', code, 'violet-harbour-77')).status, 400)
    const mine = await Member.findOne({ email: customer.email })
    await Member.collection.updateOne({ _id: mine._id }, { $set: { email: 'changed-address@example.com' } })
    assert.equal((await reset('changed-address@example.com', code, 'violet-harbour-77')).status, 400, 'a code issued for the old address is dead')
  })

  test('a code for an account that no longer exists is refused', async () => {
    const member = await makeMember()
    const code = await requestCode(customer.email)
    await Member.deleteOne({ _id: member._id })
    assert.equal((await reset(customer.email, code, 'violet-harbour-77')).status, 400)
  })

  test('a weak password is rejected without costing an attempt, and the code keeps working', async () => {
    await makeMember()
    const code = await requestCode(customer.email)
    for (let i = 0; i < MAX_ATTEMPTS + 1; i += 1) {
      const weak = await reset(customer.email, code, 'letmein123')
      assert.equal(weak.status, 400)
      assert.ok(weak.body.errors.password)
    }
    assert.equal((await PasswordResetCode.findOne()).attempts, 0)
    assert.equal((await reset(customer.email, code, 'violet-harbour-77')).status, 200)
  })

  test('only a correct code learns whether the password is acceptable', async () => {
    await makeMember()
    const code = await requestCode(customer.email)
    const wrongCode = await reset(customer.email, wrongCodeFor(code), 'letmein123')
    assert.equal(wrongCode.body.code, 'RESET_CODE_INVALID')
    assert.equal(wrongCode.body.errors, undefined)
  })

  test('resetting clears the sign-in delay so the owner can get straight back in', async () => {
    await makeMember()
    for (let i = 0; i < 25; i += 1) await throttle.recordFailure('member', { ip: `198.51.100.${i}`, email: customer.email })
    assert.ok(await throttle.check('member', { ip: '192.0.2.1', email: customer.email }) > 0)
    const code = await requestCode(customer.email)
    await reset(customer.email, code, 'violet-harbour-77')
    assert.equal(await throttle.check('member', { ip: '192.0.2.1', email: customer.email }), 0)
    assert.equal((await request(app).post('/api/auth/login').send({ email: customer.email, password: 'violet-harbour-77' })).status, 200)
  })

  test('old records with an unrelated invalid field can still reset and change their password', async () => {
    const member = await makeMember()
    await Member.collection.updateOne({ _id: member._id }, { $set: { phone: 'not-a-phone', cnic: 'bad' } })
    const code = await requestCode(customer.email)
    assert.equal((await reset(customer.email, code, 'violet-harbour-77')).status, 200)
    const signedIn = await request(app).post('/api/auth/login').send({ email: customer.email, password: 'violet-harbour-77' })
    const change = await request(app).post('/api/auth/change-password').set({ Authorization: `Bearer ${signedIn.body.token}` })
      .send({ current: 'violet-harbour-77', newPassword: 'amber-meadow-58' })
    assert.equal(change.status, 200)
  })

  test('resetting does not depend on the confirmation email being delivered', async () => {
    await makeMember()
    const code = await requestCode(customer.email)
    email.sendPasswordChangedEmail = async () => { throw new Error('provider down') }
    assert.equal((await reset(customer.email, code, 'violet-harbour-77')).status, 200)
  })
})

describe('password-changed notification', () => {
  test('is sent after a reset and after a change from the account settings, to the account address', async () => {
    const member = await makeMember()
    const code = await requestCode(customer.email)
    await reset(customer.email, code, 'violet-harbour-77')
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
    assert.match(sent[0].html, /using a password reset code/)
    assert.match(sent[0].html, /Sun, 01 Nov 2026 10:00:00 GMT/)
    assert.match(sent[0].html, /http:\/\/127\.0\.0\.1:5173\/forgot-password/)
    assert.ok(!sent[0].html.includes('<script>'))
    assert.match(sent[0].html, /&lt;script&gt;/)
    await original.changed('member@example.com', { name: 'Someone', reason: 'change' })
    assert.match(sent[1].html, /from your account settings/)
  })
})
