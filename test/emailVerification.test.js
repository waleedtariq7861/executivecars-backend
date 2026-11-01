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
// Verification is under test here, so nobody is grandfathered unless a test sets a cutoff.
delete process.env.AUTH_VERIFICATION_CUTOFF

const { before, after, beforeEach, afterEach, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const axios = require('axios')
const mongoose = require('mongoose')
const request = require('supertest')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const Member = require('../src/models/Member')
const Seller = require('../src/models/Seller')
const EmailVerificationCode = require('../src/models/EmailVerificationCode')
const email = require('../src/utils/email')
const { validateRuntimeConfig } = require('../src/config/runtime')
const { DAILY_LIMIT, MAX_ATTEMPTS, RESEND_INTERVAL_MS, DAY_MS, issueCode, isEmailVerified } = require('../src/utils/emailVerification')

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

// Mail is captured. "smtp" delivery keeps the development-only code out of responses, as in a real deployment.
const original = { send: email.sendVerificationCodeEmail, mode: process.env.EMAIL_DELIVERY_MODE, app: process.env.APP_MODE }
let mails
beforeEach(async () => {
  await resetTestDatabase()
  mails = []
  process.env.EMAIL_DELIVERY_MODE = 'smtp'
  delete process.env.AUTH_VERIFICATION_CUTOFF
  email.sendVerificationCodeEmail = async (to, details) => { mails.push({ to, ...details }) }
})
afterEach(() => {
  email.sendVerificationCodeEmail = original.send
  process.env.EMAIL_DELIVERY_MODE = original.mode
  if (original.app === undefined) delete process.env.APP_MODE
  else process.env.APP_MODE = original.app
  delete process.env.AUTH_VERIFICATION_CUTOFF
})

const person = { name: 'Verify Customer', email: 'verify-customer@example.com', phone: '+92 300 5550301', password: 'orchid-lantern-42' }
const signUp = (overrides = {}) => request(app).post('/api/auth/register').send({ ...person, ...overrides })
const bearer = body => ({ Authorization: `Bearer ${body.token}` })
const sendCode = auth => request(app).post('/api/auth/email/send-code').set(auth)
const verify = (auth, code) => request(app).post('/api/auth/email/verify').set(auth).send({ code })
const sessionUser = async auth => (await request(app).get('/api/auth/session').set(auth)).body.user
// Moves the last send back in time so the next request is not held by the one-minute wait.
const ageLastSend = ms => EmailVerificationCode.updateMany({}, { $set: { lastSentAt: new Date(Date.now() - ms) } })

const signUpVerified = async () => {
  const response = await signUp()
  assert.equal(response.status, 201)
  const auth = bearer(response.body)
  const done = await verify(auth, mails.at(-1).code)
  assert.equal(done.status, 200)
  return auth
}

describe('sign-up', () => {
  test('creates an unverified account and mails a 6-digit code to its address', async () => {
    const response = await signUp()
    assert.equal(response.status, 201)
    assert.equal(response.body.user.emailVerified, false)
    assert.deepEqual(response.body.verification, { sent: true, delivery: 'email', expiresInSeconds: 600 })
    assert.equal(mails.length, 1)
    assert.equal(mails[0].to, person.email)
    assert.equal(mails[0].name, person.name)
    assert.match(mails[0].code, /^\d{6}$/)
    assert.ok(!JSON.stringify(response.body).includes(mails[0].code), 'the code must never be in the response')
  })

  test('stores only a digest of the code, never the code', async () => {
    await signUp()
    const record = await EmailVerificationCode.findOne().lean()
    assert.ok(!JSON.stringify(record).includes(mails[0].code))
    assert.match(record.otpDigest, /^[a-f0-9]{64}$/)
    assert.ok(record.expiresAt.getTime() > Date.now() + 9 * 60 * 1000)
  })

  test('local demo delivery shows the code on screen instead of mailing it', async () => {
    process.env.EMAIL_DELIVERY_MODE = 'development'
    const response = await signUp()
    assert.equal(response.body.verification.delivery, 'development')
    assert.match(response.body.verification.devCode, /^\d{6}$/)
    assert.equal(mails.length, 0)
  })

  test('if the mail provider fails in a real deployment the account is still created and says the code was not sent', async () => {
    process.env.APP_MODE = 'production'
    email.sendVerificationCodeEmail = async () => { throw new Error('provider down') }
    const response = await signUp()
    assert.equal(response.status, 201)
    assert.deepEqual(response.body.verification, { sent: false, failed: true })
    assert.equal(await EmailVerificationCode.countDocuments(), 0, 'no code should be left behind for a mail that never left')
    // ...and asking again straight away is allowed, because nothing was used up.
    email.sendVerificationCodeEmail = async (to, details) => { mails.push({ to, ...details }) }
    const retry = await sendCode(bearer(response.body))
    assert.equal(retry.status, 200)
    assert.equal(mails.length, 1)
  })

  test('in local demo mode a failing provider falls back to the on-screen code', async () => {
    email.sendVerificationCodeEmail = async () => { throw new Error('no smtp here') }
    const response = await signUp()
    assert.equal(response.status, 201)
    assert.equal(response.body.verification.delivery, 'development')
    assert.match(response.body.verification.devCode, /^\d{6}$/)
  })

  test('a legacy seller who signs in through the unified form arrives already verified', async () => {
    const seller = await Seller.create({ name: 'Old Seller', email: 'old-seller@example.com', password: 'placeholder-pass-1' })
    await Seller.updateOne({ _id: seller._id }, { $set: { password: await bcrypt.hash('seller-pass-123', 4) } })
    const login = await request(app).post('/api/auth/login').send({ email: seller.email, password: 'seller-pass-123' })
    assert.equal(login.status, 200)
    assert.equal(login.body.user.emailVerified, true)
  })
})

describe('sending a code', () => {
  test('needs a signed-in customer', async () => {
    assert.equal((await request(app).post('/api/auth/email/send-code')).status, 401)
    const admin = await Admin.create({ name: 'Verify Admin', email: 'verify-admin@example.com', password: 'admin-pass-123', role: 'admin' })
    const login = await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })
    assert.equal((await sendCode(bearer(login.body))).status, 403)
  })

  test('allows one code a minute, then again once the minute is over', async () => {
    const auth = bearer((await signUp()).body)
    const tooSoon = await sendCode(auth)
    assert.equal(tooSoon.status, 429)
    assert.equal(tooSoon.body.code, 'RESEND_TOO_SOON')
    assert.ok(Number(tooSoon.headers['retry-after']) >= 1)
    assert.ok(tooSoon.body.retryAfterSeconds >= 1)
    assert.equal(mails.length, 1)

    await ageLastSend(RESEND_INTERVAL_MS + 1000)
    const again = await sendCode(auth)
    assert.equal(again.status, 200)
    assert.equal(mails.length, 2)
  })

  test(`allows ${DAILY_LIMIT} codes a day and then refuses until the day is over`, async () => {
    const auth = bearer((await signUp()).body)
    for (let i = 1; i < DAILY_LIMIT; i += 1) {
      await ageLastSend(RESEND_INTERVAL_MS + 1000)
      assert.equal((await sendCode(auth)).status, 200)
    }
    assert.equal(mails.length, DAILY_LIMIT)
    await ageLastSend(RESEND_INTERVAL_MS + 1000)
    const over = await sendCode(auth)
    assert.equal(over.status, 429)
    assert.equal(over.body.code, 'DAILY_LIMIT')
    assert.equal(mails.length, DAILY_LIMIT)

    await EmailVerificationCode.updateMany({}, { $set: { dayStartedAt: new Date(Date.now() - DAY_MS - 1000), lastSentAt: new Date(Date.now() - DAY_MS - 1000) } })
    assert.equal((await sendCode(auth)).status, 200)
  })

  test('replacing a code makes the earlier one useless', async () => {
    const auth = bearer((await signUp()).body)
    const first = mails.at(-1).code
    await ageLastSend(RESEND_INTERVAL_MS + 1000)
    await sendCode(auth)
    const second = mails.at(-1).code
    assert.notEqual(first, second)
    const stale = await verify(auth, first)
    assert.equal(stale.status, 400)
    assert.equal(stale.body.code, 'CODE_INCORRECT')
    assert.equal((await verify(auth, second)).status, 200)
  })

  test('says so when the provider fails, without using up the allowance', async () => {
    process.env.APP_MODE = 'production'
    const auth = bearer((await signUp()).body)
    await ageLastSend(RESEND_INTERVAL_MS + 1000)
    email.sendVerificationCodeEmail = async () => { throw new Error('provider down') }
    const failed = await sendCode(auth)
    assert.equal(failed.status, 502)
    assert.equal(failed.body.code, 'EMAIL_SEND_FAILED')
    assert.equal(await EmailVerificationCode.countDocuments(), 0)
  })

  test('does nothing for an account that is already verified', async () => {
    const auth = await signUpVerified()
    const before = mails.length
    const response = await sendCode(auth)
    assert.deepEqual(response.body, { verified: true })
    assert.equal(mails.length, before)
  })
})

describe('entering the code', () => {
  test('a correct code verifies the account and is consumed', async () => {
    const response = await signUp()
    const auth = bearer(response.body)
    const done = await verify(auth, mails[0].code)
    assert.equal(done.status, 200)
    assert.deepEqual(done.body, { verified: true })
    assert.equal((await sessionUser(auth)).emailVerified, true)
    assert.ok((await Member.findOne({ email: person.email })).emailVerifiedAt instanceof Date)
    assert.equal(await EmailVerificationCode.countDocuments(), 0)
  })

  test('tolerates spaces typed or pasted into the code', async () => {
    const auth = bearer((await signUp()).body)
    const code = mails[0].code
    assert.equal((await verify(auth, `${code.slice(0, 3)} ${code.slice(3)}`)).status, 200)
  })

  test('rejects anything that is not 6 digits without using an attempt', async () => {
    const auth = bearer((await signUp()).body)
    for (const bad of ['12345', '1234567', 'abcdef', '', '12 34', null, 123456.5]) {
      const response = await verify(auth, bad)
      assert.equal(response.status, 400, String(bad))
      assert.equal(response.body.code, 'CODE_FORMAT')
    }
    assert.equal((await EmailVerificationCode.findOne()).attempts, 0)
  })

  test(`a wrong code says how many tries are left and the code dies after ${MAX_ATTEMPTS}`, async () => {
    const auth = bearer((await signUp()).body)
    const right = mails[0].code
    const wrong = right === '000000' ? '111111' : '000000'
    const first = await verify(auth, wrong)
    assert.equal(first.status, 400)
    assert.equal(first.body.code, 'CODE_INCORRECT')
    assert.equal(first.body.remainingAttempts, MAX_ATTEMPTS - 1)
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) await verify(auth, wrong)
    const locked = await verify(auth, right)
    assert.equal(locked.status, 429)
    assert.equal(locked.body.code, 'TOO_MANY_ATTEMPTS')
    assert.equal((await sessionUser(auth)).emailVerified, false)

    await ageLastSend(RESEND_INTERVAL_MS + 1000)
    await sendCode(auth)
    assert.equal((await verify(auth, mails.at(-1).code)).status, 200, 'a new code starts a fresh set of tries')
  })

  test('parallel guesses cannot exceed the limit', async () => {
    const auth = bearer((await signUp()).body)
    const wrong = mails[0].code === '000000' ? '111111' : '000000'
    const results = await Promise.all(Array.from({ length: 12 }, () => verify(auth, wrong)))
    assert.equal(results.filter(result => result.body.code === 'CODE_INCORRECT').length, MAX_ATTEMPTS)
    assert.equal((await EmailVerificationCode.findOne()).attempts, MAX_ATTEMPTS)
    assert.equal((await verify(auth, mails[0].code)).status, 429)
  })

  test('an expired code is refused and removed', async () => {
    const auth = bearer((await signUp()).body)
    await EmailVerificationCode.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    const response = await verify(auth, mails[0].code)
    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'CODE_EXPIRED')
    assert.equal(await EmailVerificationCode.countDocuments(), 0)
  })

  test('without a pending code there is nothing to enter', async () => {
    const auth = bearer((await signUp()).body)
    await EmailVerificationCode.deleteMany({})
    const response = await verify(auth, '123456')
    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'NO_CODE')
  })

  test("one account's code does not verify another account", async () => {
    const alice = bearer((await signUp()).body)
    const bob = bearer((await signUp({ name: 'Other Customer', email: 'other-customer@example.com', phone: '+92 300 5550302' })).body)
    const aliceCode = mails.find(mail => mail.to === person.email).code
    assert.equal((await verify(bob, aliceCode)).status, 400, 'a code issued to one account must not verify another')
    assert.equal((await sessionUser(bob)).emailVerified, false)
    assert.equal((await verify(alice, aliceCode)).status, 200)
  })

  test('a code only counts for the address it was sent to', async () => {
    const auth = bearer((await signUp()).body)
    await EmailVerificationCode.updateMany({}, { $set: { email: 'someone-else@example.com' } })
    assert.equal((await verify(auth, mails[0].code)).status, 400)
  })
})

describe('what an unverified customer cannot do', () => {
  test('cannot place a bid or activate membership, and is told why', async () => {
    const auth = bearer((await signUp()).body)
    const carId = new mongoose.Types.ObjectId().toString()
    const bid = await request(app).post('/api/bids').set(auth).send({ carId, amount: 5000000 })
    assert.equal(bid.status, 403)
    assert.equal(bid.body.code, 'EMAIL_NOT_VERIFIED')
    const payment = await request(app).post('/api/payments/demo-complete').set(auth)
    assert.equal(payment.status, 403)
    assert.equal(payment.body.code, 'EMAIL_NOT_VERIFIED')
  })

  test('can still use the rest of the account', async () => {
    const auth = bearer((await signUp()).body)
    assert.equal((await request(app).get('/api/member/profile').set(auth)).status, 200)
  })

  test('after verifying, the same actions get past the email check', async () => {
    const auth = await signUpVerified()
    const carId = new mongoose.Types.ObjectId().toString()
    const bid = await request(app).post('/api/bids').set(auth).send({ carId, amount: 5000000 })
    assert.notEqual(bid.body.code, 'EMAIL_NOT_VERIFIED')
    assert.equal(bid.body.message, 'Active membership required', 'the next check (membership) is now the one that answers')
    const payment = await request(app).post('/api/payments/demo-complete').set(auth)
    assert.equal(payment.status, 201)
  })

  test('administrators are not asked to verify an email', async () => {
    const admin = await Admin.create({ name: 'Verify Admin', email: 'verify-admin@example.com', password: 'admin-pass-123', role: 'admin' })
    const login = await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })
    const bid = await request(app).post('/api/bids').set(bearer(login.body)).send({ carId: new mongoose.Types.ObjectId().toString(), amount: 5000000 })
    assert.notEqual(bid.body.code, 'EMAIL_NOT_VERIFIED')
  })
})

describe('verifying by another route', () => {
  test('a booking code mailed to the customer proves the address too', async () => {
    process.env.EMAIL_DELIVERY_MODE = 'development'
    const auth = bearer((await signUp()).body)
    const sent = await request(app).post('/api/bookings/send-otp').set(auth).send({})
    assert.equal(sent.status, 200)
    assert.equal((await sessionUser(auth)).emailVerified, false)
    const done = await request(app).post('/api/bookings/verify-otp').set(auth).send({ otp: sent.body.devOtp })
    assert.equal(done.status, 200)
    assert.equal((await sessionUser(auth)).emailVerified, true)
  })

  test('a wrong booking code verifies nothing', async () => {
    process.env.EMAIL_DELIVERY_MODE = 'development'
    const auth = bearer((await signUp()).body)
    const sent = await request(app).post('/api/bookings/send-otp').set(auth).send({})
    const wrong = sent.body.devOtp === '000000' ? '111111' : '000000'
    assert.equal((await request(app).post('/api/bookings/verify-otp').set(auth).send({ otp: wrong })).status, 400)
    assert.equal((await sessionUser(auth)).emailVerified, false)
  })
})

describe('customers who existed before the release', () => {
  test('count as verified when they were created before the cutoff, with no database change', async () => {
    process.env.AUTH_VERIFICATION_CUTOFF = new Date(Date.now() + 3600_000).toISOString()
    const response = await signUp()
    assert.equal(response.body.user.emailVerified, true)
    assert.equal((await Member.findOne({ email: person.email })).emailVerifiedAt, undefined)
    const payment = await request(app).post('/api/payments/demo-complete').set(bearer(response.body))
    assert.equal(payment.status, 201)
  })

  test('accounts created after the cutoff must verify', async () => {
    process.env.AUTH_VERIFICATION_CUTOFF = new Date(Date.now() - 3600_000).toISOString()
    assert.equal((await signUp()).body.user.emailVerified, false)
  })

  test('nobody is grandfathered when no cutoff is configured', async () => {
    delete process.env.AUTH_VERIFICATION_CUTOFF
    assert.equal((await signUp()).body.user.emailVerified, false)
    assert.equal(isEmailVerified({ createdAt: new Date(0) }), false)
    process.env.AUTH_VERIFICATION_CUTOFF = 'not-a-date'
    assert.equal(isEmailVerified({ createdAt: new Date(0) }), false)
  })

  test('an invalid cutoff is rejected at startup', () => {
    const base = { NODE_ENV: 'test', APP_MODE: 'demo', EMAIL_DELIVERY_MODE: 'development' }
    assert.doesNotThrow(() => validateRuntimeConfig({ ...base, AUTH_VERIFICATION_CUTOFF: '2026-11-02T00:00:00Z' }))
    assert.throws(() => validateRuntimeConfig({ ...base, AUTH_VERIFICATION_CUTOFF: 'soon' }), /AUTH_VERIFICATION_CUTOFF/)
  })

  test('the demo seed creates customers that are already verified', async () => {
    const { seedDemo } = require('../scripts/seedDemo')
    await seedDemo()
    const seeded = await Member.findOne({ email: 'member@executivecars.pk' })
    assert.ok(seeded.emailVerifiedAt instanceof Date)
    assert.equal(seeded.isEmailVerified(), true)
  })
})

describe('the code email', () => {
  test('contains the code and the validity, escapes the name and is sent from the configured provider', async t => {
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
    await original.send('member@example.com', { name: '<b>Mallory</b>', code: '042917' })
    assert.deepEqual(sent[0].to, ['member@example.com'])
    assert.equal(sent[0].subject, 'Verify your Executive Cars email address')
    assert.match(sent[0].html, /042917/)
    assert.match(sent[0].html, /10 minutes/)
    assert.ok(!sent[0].html.includes('<b>Mallory</b>'))
  })

  test('codes keep their leading zeros', async () => {
    const crypto = require('node:crypto')
    const member = await Member.create({ name: 'Zero Code', email: 'zero@example.com', password: 'orchid-lantern-42' })
    const randomInt = crypto.randomInt
    crypto.randomInt = () => 42
    try {
      assert.equal((await issueCode(member)).code, '000042')
    } finally {
      crypto.randomInt = randomInt
    }
  })
})
