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

const { before, after, beforeEach, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const mongoose = require('mongoose')
const request = require('supertest')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const Member = require('../src/models/Member')
const Seller = require('../src/models/Seller')
const LoginAttempt = require('../src/models/LoginAttempt')
const PasswordResetToken = require('../src/models/PasswordResetToken')
const { hashPassword, verifyPassword, verifyWithEqualCost, needsRehash } = require('../src/utils/passwordHash')
const { validatePassword, isBreached } = require('../src/utils/passwordPolicy')
const throttle = require('../src/utils/loginThrottle')
const limiters = require('../src/middleware/rateLimits')
const { validateRuntimeConfig } = require('../src/config/runtime')

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

beforeEach(async () => {
  await resetTestDatabase()
})

const person = { name: 'Credential Tester', email: 'credentials@example.com', phone: '+92 300 5550199', password: 'orchid-lantern-42' }
const register = (overrides = {}) => request(app).post('/api/auth/register').send({ ...person, ...overrides })
const login = (password, email = person.email) => request(app).post('/api/auth/login').send({ email, password })

// An account whose hash is a legacy bcrypt one, exactly as created before Argon2id.
const legacyBcryptMember = async (password = person.password, cost = 4) => {
  const member = await Member.create({ name: person.name, email: person.email, phone: person.phone, password: 'placeholder-pass-1' })
  await Member.updateOne({ _id: member._id }, { $set: { password: await bcrypt.hash(password, cost) } })
  return member
}

describe('password hashing', () => {
  test('new hashes are Argon2id with the documented parameters and verify only the right password', async () => {
    const hash = await hashPassword('correct horse battery')
    assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    assert.equal(await verifyPassword('correct horse battery', hash), true)
    assert.equal(await verifyPassword('correct horse batterz', hash), false)
    assert.equal(needsRehash(hash), false)
  })

  test('legacy bcrypt hashes still verify and are flagged for upgrade; junk never verifies', async () => {
    const legacy = await bcrypt.hash('legacy-password-1', 4)
    assert.equal(await verifyPassword('legacy-password-1', legacy), true)
    assert.equal(await verifyPassword('legacy-password-2', legacy), false)
    assert.equal(needsRehash(legacy), true)
    for (const junk of ['', 'plain-text-password', '$argon2id$not-a-real-hash', undefined, null]) {
      assert.equal(await verifyPassword('plain-text-password', junk), false)
    }
    assert.equal(await verifyPassword('', await hashPassword('something-else-1')), false)
  })

  test('hashes made with weaker Argon2 parameters are flagged for upgrade', () => {
    assert.equal(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHQ$aGFzaA'), true)
  })

  test('equal-cost verification returns the real answer for any hash type, or false when there is no account', async () => {
    const argon = await hashPassword('mixed-scheme-pass')
    const legacy = await bcrypt.hash('mixed-scheme-pass', 4)
    assert.equal(await verifyWithEqualCost('mixed-scheme-pass', argon), true)
    assert.equal(await verifyWithEqualCost('mixed-scheme-pass', legacy), true)
    assert.equal(await verifyWithEqualCost('wrong-pass-word', argon), false)
    assert.equal(await verifyWithEqualCost('wrong-pass-word', legacy), false)
    assert.equal(await verifyWithEqualCost('mixed-scheme-pass', undefined), false)
  })

  test('Member, Admin and Seller all store Argon2id and keep matchPassword working', async () => {
    const admin = await Admin.create({ name: 'Hash Admin', email: 'hash-admin@example.com', password: 'admin-pass-123', role: 'admin' })
    const seller = await Seller.create({ name: 'Hash Seller', email: 'hash-seller@example.com', password: 'seller-pass-123' })
    const member = await Member.create({ name: 'Hash Member', email: 'hash-member@example.com', password: 'member-pass-123' })
    for (const [account, password] of [[admin, 'admin-pass-123'], [seller, 'seller-pass-123'], [member, 'member-pass-123']]) {
      assert.match(account.password, /^\$argon2id\$/)
      assert.equal(await account.matchPassword(password), true)
      assert.equal(await account.matchPassword(`${password}-x`), false)
      assert.ok(account.passwordChangedAt instanceof Date)
    }
  })

  test('saving other fields does not re-hash the password', async () => {
    const member = await Member.create({ name: 'Stable Hash', email: 'stable@example.com', password: 'member-pass-123' })
    const before = member.password
    member.city = 'Lahore'
    await member.save()
    assert.equal((await Member.findById(member._id)).password, before)
  })
})

describe('password policy', () => {
  const noBreachCheck = { checkBreaches: false }
  const check = (password, context = {}) => validatePassword(password, context, noBreachCheck)

  test('accepts long passphrases and any characters, with no composition rules', async () => {
    for (const ok of ['orchid-lantern-42', 'correct horse battery staple', 'ﾟ日本語のパスワードです', 'alllowercaseletters', '12-34-56-78-90']) {
      assert.deepEqual(await check(ok), { ok: true }, ok)
    }
  })

  test('enforces 8 to 128 characters, counting characters rather than bytes', async () => {
    assert.equal((await check('short1')).code, 'PASSWORD_TOO_SHORT')
    assert.equal((await check('1234567')).code, 'PASSWORD_TOO_SHORT')
    assert.deepEqual(await check('日本語のパスワード'), { ok: true })
    assert.deepEqual(await check('a1'.repeat(64)), { ok: true })
    assert.equal((await check('a1'.repeat(64) + 'x')).code, 'PASSWORD_TOO_LONG')
    assert.equal((await check(undefined)).code, 'PASSWORD_REQUIRED')
    assert.equal((await check(12345678)).code, 'PASSWORD_REQUIRED')
  })

  test('rejects common passwords whatever their case, and single repeated characters', async () => {
    for (const common of ['password', 'PASSWORD', 'Password1', 'qwertyuiop', 'iloveyou', '12345678', 'password123', 'Summer2024!', 'letmein!!!']) {
      assert.equal((await check(common)).code, 'PASSWORD_COMMON', common)
    }
    assert.equal((await check('aaaaaaaaaa')).code, 'PASSWORD_COMMON')
    // A common word inside a longer passphrase is fine; only the word plus trailing decoration is blocked.
    assert.deepEqual(await check('dragon-fruit-salad-9'), { ok: true })
    assert.deepEqual(await check('summertime-orchard-3'), { ok: true })
  })

  test('rejects passwords built from the email, the name or the site name', async () => {
    const context = { email: 'waleed.tariq@example.com', name: 'Waleed Tariq' }
    assert.equal((await check('waleedtariq-2026', context)).code, 'PASSWORD_CONTAINS_PERSONAL')
    assert.equal((await check('MyWaleed!Pass', context)).code, 'PASSWORD_CONTAINS_PERSONAL')
    assert.equal((await check('x-tariq-x-x-x-x', context)).code, 'PASSWORD_CONTAINS_PERSONAL')
    assert.equal((await check('lucky-executive-cars-9', context)).code, 'PASSWORD_CONTAINS_PERSONAL')
    assert.deepEqual(await check('orchid-lantern-42', context), { ok: true })
    // Very short name parts are not treated as secrets: they would match by coincidence.
    assert.deepEqual(await check('alibaba-orchid-lantern', { name: 'Ali Raza' }), { ok: true })
  })

  test('breach check sends only a 5-character hash prefix and rejects a breached password', async () => {
    const password = 'breached-sample-pass'
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase()
    const urls = []
    const fetchImpl = async (url, options) => {
      urls.push({ url, headers: options.headers })
      return { ok: true, text: async () => `0000000000000000000000000000000000A:3\r\n${sha1.slice(5)}:1042\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0` }
    }
    const result = await validatePassword(password, {}, { checkBreaches: true, fetchImpl })
    assert.equal(result.code, 'PASSWORD_BREACHED')
    assert.equal(urls.length, 1)
    assert.equal(urls[0].url, `https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`)
    assert.equal(urls[0].headers['Add-Padding'], 'true')
    assert.ok(!urls[0].url.includes(sha1.slice(5)), 'the full hash must never be sent')
  })

  test('padding rows with a zero count do not count as a breach', async () => {
    const password = 'padding-only-pass'
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase()
    const fetchImpl = async () => ({ ok: true, text: async () => `${sha1.slice(5)}:0` })
    assert.deepEqual(await validatePassword(password, {}, { checkBreaches: true, fetchImpl }), { ok: true })
  })

  test('breach check fails open: outage, bad status or timeout never blocks a sign-up', async () => {
    const password = 'unreachable-service-1'
    const cases = [
      async () => { throw new Error('network down') },
      async () => ({ ok: false, status: 503, text: async () => 'unavailable' }),
      async () => ({ ok: true, text: async () => { throw new Error('truncated body') } }),
    ]
    for (const fetchImpl of cases) {
      assert.deepEqual(await validatePassword(password, {}, { checkBreaches: true, fetchImpl }), { ok: true })
    }
    assert.equal(await isBreached(password, undefined), false)
    assert.equal(await isBreached(password, 'not-a-function'), false)
  })

  test('breach check is off in tests unless asked for, and on in production unless disabled', async () => {
    let called = 0
    const fetchImpl = async () => { called += 1; return { ok: true, text: async () => '' } }
    await validatePassword('orchid-lantern-42', {}, { fetchImpl })
    assert.equal(called, 0)
    const previous = { env: process.env.NODE_ENV, flag: process.env.HIBP_ENABLED }
    try {
      process.env.NODE_ENV = 'production'
      delete process.env.HIBP_ENABLED
      await validatePassword('orchid-lantern-42', {}, { fetchImpl })
      assert.equal(called, 1)
      process.env.HIBP_ENABLED = 'false'
      await validatePassword('orchid-lantern-42', {}, { fetchImpl })
      assert.equal(called, 1)
    } finally {
      process.env.NODE_ENV = previous.env
      if (previous.flag === undefined) delete process.env.HIBP_ENABLED
      else process.env.HIBP_ENABLED = previous.flag
    }
  })
})

test('HIBP_ENABLED must be true or false when set', () => {
  const base = { NODE_ENV: 'test', APP_MODE: 'demo', EMAIL_DELIVERY_MODE: 'development' }
  assert.doesNotThrow(() => validateRuntimeConfig({ ...base, HIBP_ENABLED: 'true' }))
  assert.doesNotThrow(() => validateRuntimeConfig({ ...base, HIBP_ENABLED: 'FALSE' }))
  assert.throws(() => validateRuntimeConfig({ ...base, HIBP_ENABLED: 'maybe' }), /HIBP_ENABLED/)
})

describe('policy is enforced on every way of choosing a password', () => {
  test('registration rejects weak passwords with a field-level error and creates nothing', async () => {
    const cases = [
      ['short1', 'PASSWORD_TOO_SHORT'],
      ['password123', 'PASSWORD_COMMON'],
      ['credentialtester-1', 'PASSWORD_CONTAINS_PERSONAL'],
    ]
    for (const [password, code] of cases) {
      const response = await register({ password })
      assert.equal(response.status, 400, password)
      assert.equal(response.body.code, code)
      assert.ok(response.body.errors.password)
    }
    assert.equal(await Member.countDocuments(), 0)
  })

  test('registration accepts a strong password and stores an Argon2id hash', async () => {
    const response = await register()
    assert.equal(response.status, 201)
    assert.match((await Member.findOne({ email: person.email })).password, /^\$argon2id\$/)
  })

  test('changing a password applies the policy, refuses reuse and reports a wrong current password per field', async () => {
    const signedUp = await register()
    const auth = { Authorization: `Bearer ${signedUp.body.token}` }
    const change = body => request(app).post('/api/auth/change-password').set(auth).send(body)

    const weak = await change({ current: person.password, newPassword: 'password123' })
    assert.equal(weak.status, 400)
    assert.equal(weak.body.code, 'PASSWORD_COMMON')
    const same = await change({ current: person.password, newPassword: person.password })
    assert.equal(same.body.code, 'PASSWORD_UNCHANGED')
    const wrong = await change({ current: 'not-my-password', newPassword: 'violet-harbour-77' })
    assert.equal(wrong.status, 400)
    assert.ok(wrong.body.errors.current)
    const ok = await change({ current: person.password, newPassword: 'violet-harbour-77' })
    assert.equal(ok.status, 200)
    assert.equal((await login('violet-harbour-77')).status, 200)
  })

  test('resetting a password applies the policy and keeps the link usable after a rejection', async () => {
    await register()
    const member = await Member.findOne({ email: person.email })
    const rawToken = crypto.randomBytes(32).toString('hex')
    await PasswordResetToken.create({
      accountId: member._id, tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'), expiresAt: new Date(Date.now() + 60_000),
    })
    const reset = password => request(app).post('/api/auth/reset-password').send({ token: rawToken, password })

    const weak = await reset('letmein123')
    assert.equal(weak.status, 400)
    assert.equal(weak.body.code, 'PASSWORD_COMMON')
    assert.equal(await PasswordResetToken.countDocuments(), 1, 'a rejected password must not burn the link')
    const strong = await reset('amber-meadow-58')
    assert.equal(strong.status, 200)
    assert.equal((await login('amber-meadow-58')).status, 200)
    assert.equal((await reset('another-pass-99')).status, 400, 'the link works once')
  })
})

describe('legacy bcrypt hashes are upgraded at sign-in', () => {
  test('a correct sign-in replaces the bcrypt hash with Argon2id without counting as a password change', async () => {
    const member = await legacyBcryptMember()
    const before = await Member.findById(member._id)
    assert.match(before.password, /^\$2[aby]\$/)
    const response = await login(person.password)
    assert.equal(response.status, 200)
    const after = await Member.findById(member._id)
    assert.match(after.password, /^\$argon2id\$/)
    assert.equal(await after.matchPassword(person.password), true)
    assert.equal(String(after.passwordChangedAt), String(before.passwordChangedAt))
    assert.equal((await login(person.password)).status, 200, 'the upgraded hash keeps working')
  })

  test('registering with an email that belongs to a legacy seller gets a plain "already exists" answer', async () => {
    await Seller.create({ name: 'Legacy Seller', email: person.email, password: 'seller-pass-123' })
    const response = await register()
    assert.equal(response.status, 409)
    assert.match(response.body.message, /already exists for this email/)
    assert.doesNotMatch(response.body.message, /seller/i)
  })

  test('a wrong password leaves the old hash untouched', async () => {
    const member = await legacyBcryptMember()
    const before = (await Member.findById(member._id)).password
    assert.equal((await login('definitely-wrong-1')).status, 401)
    assert.equal((await Member.findById(member._id)).password, before)
  })

  test('an administrator hash is upgraded the same way', async () => {
    const admin = await Admin.create({ name: 'Old Admin', email: 'old-admin@example.com', password: 'placeholder-pass-1', role: 'admin' })
    await Admin.updateOne({ _id: admin._id }, { $set: { password: await bcrypt.hash('admin-pass-123', 4) } })
    const response = await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })
    assert.equal(response.status, 200)
    assert.match((await Admin.findById(admin._id)).password, /^\$argon2id\$/)
  })

  test('a legacy seller signing in through the unified form becomes an Argon2id member', async () => {
    const seller = await Seller.create({ name: 'Legacy Seller', email: 'legacy-seller@example.com', password: 'placeholder-pass-1' })
    await Seller.updateOne({ _id: seller._id }, { $set: { password: await bcrypt.hash('seller-pass-123', 4) } })
    const response = await login('seller-pass-123', seller.email)
    assert.equal(response.status, 200)
    assert.equal(response.body.user.sellerApproved, true)
    assert.match((await Member.findOne({ email: seller.email })).password, /^\$argon2id\$/)
  })
})

describe('sign-in throttling', () => {
  const who = { ip: '203.0.113.7', email: 'victim@example.com' }
  const T0 = 1_800_000_000_000
  const fail = async (kind, times, identity = who, at = T0) => { for (let i = 0; i < times; i += 1) await throttle.recordFailure(kind, identity, at) }

  test('the first failures are free, then a delay starts and doubles up to a cap', async () => {
    await fail('member', 5)
    assert.equal(await throttle.check('member', who, T0), 0)
    await fail('member', 1)
    assert.equal(await throttle.check('member', who, T0), 1)
    await fail('member', 1, who, T0 + 1000)
    assert.equal(await throttle.check('member', who, T0 + 1000), 2)
    assert.equal(throttle.delayFor(6, 5), 1000)
    assert.equal(throttle.delayFor(9, 5), 8000)
    assert.equal(throttle.delayFor(40, 5), 15 * 60 * 1000)
  })

  test('the delay is a pause, not a lock: it ends by itself', async () => {
    await fail('member', 8)
    const wait = await throttle.check('member', who, T0)
    assert.ok(wait >= 4)
    assert.equal(await throttle.check('member', who, T0 + (wait + 1) * 1000), 0)
  })

  test('one account is throttled across many addresses, and an unknown email is throttled exactly the same', async () => {
    for (let i = 0; i < 21; i += 1) await throttle.recordFailure('member', { ip: `198.51.100.${i}`, email: 'victim@example.com' }, T0)
    assert.ok(await throttle.check('member', { ip: '192.0.2.99', email: 'victim@example.com' }, T0) > 0)
    assert.equal(await throttle.check('member', { ip: '192.0.2.99', email: 'someone-else@example.com' }, T0), 0)
    assert.equal(await throttle.check('member', { ip: '192.0.2.99', email: 'VICTIM@Example.com ' }, T0) > 0, true, 'email case and spacing do not matter')
  })

  test('one address guessing many accounts is throttled', async () => {
    for (let i = 0; i < 31; i += 1) await throttle.recordFailure('member', { ip: '203.0.113.50', email: `target${i}@example.com` }, T0)
    assert.ok(await throttle.check('member', { ip: '203.0.113.50', email: 'fresh@example.com' }, T0) > 0)
    assert.equal(await throttle.check('member', { ip: '203.0.113.51', email: 'fresh@example.com' }, T0), 0)
  })

  test('administrator sign-in tolerates fewer failures than customer sign-in', async () => {
    await fail('admin', 3)
    assert.equal(await throttle.check('admin', who, T0), 0)
    await fail('admin', 1)
    assert.ok(await throttle.check('admin', who, T0) > 0)
    await fail('member', 4)
    assert.equal(await throttle.check('member', who, T0), 0, 'customer buckets are separate from administrator buckets')
  })

  test('a correct sign-in clears the account buckets but not the address bucket', async () => {
    await fail('member', 8)
    await throttle.recordSuccess('member', who)
    assert.equal(await throttle.check('member', who, T0), 0)
    await fail('member', 25, { ip: who.ip, email: 'other@example.com' })
    await throttle.recordSuccess('member', who)
    assert.ok(await throttle.check('member', { ip: who.ip, email: 'brand-new@example.com' }, T0) > 0)
  })

  test('failures older than the window start a fresh count', async () => {
    await fail('member', 5)
    const later = T0 + throttle.WINDOW_MS + 1000
    await throttle.recordFailure('member', who, later)
    assert.equal(await throttle.check('member', who, later), 0)
  })

  test('counters hold hashes only, never the email or the address', async () => {
    await fail('member', 2)
    const raw = JSON.stringify(await LoginAttempt.find().lean())
    assert.ok(!raw.includes('victim@example.com'))
    assert.ok(!raw.includes('203.0.113.7'))
  })

  test('over HTTP: repeated wrong passwords lead to 429 with Retry-After, even for the right password', async () => {
    await register()
    for (let i = 0; i < 5; i += 1) assert.equal((await login(`wrong-password-${i}`)).status, 401)
    assert.equal((await login('wrong-password-5')).status, 401)
    const blocked = await login(person.password)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.code, 'LOGIN_THROTTLED')
    assert.ok(Number(blocked.headers['retry-after']) >= 1)
    assert.ok(blocked.body.retryAfterSeconds >= 1)
    assert.match(blocked.body.message, /Try again in/)
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.equal((await login(person.password)).status, 200, 'the delay ends and the real owner can sign in')
  })

  test('over HTTP: a throttled unknown email gets the same answer as a throttled real one', async () => {
    await register()
    const attempt = email => login('wrong-password-1', email)
    const answers = []
    for (const email of [person.email, 'nobody-here@example.com']) {
      for (let i = 0; i < 6; i += 1) assert.equal((await attempt(email)).status, 401)
      // Checked right away: the first delay is only one second long.
      answers.push(await attempt(email))
    }
    assert.deepEqual(answers.map(answer => answer.status), [429, 429])
    assert.equal(answers[0].body.code, answers[1].body.code)
  })

  test('over HTTP: the administrator login is throttled too', async () => {
    const admin = await Admin.create({ name: 'Throttle Admin', email: 'throttle-admin@example.com', password: 'admin-pass-123', role: 'admin' })
    const attempt = password => request(app).post('/api/auth/admin/login').send({ email: admin.email, password })
    for (let i = 0; i < 4; i += 1) assert.equal((await attempt(`wrong-admin-${i}`)).status, 401)
    assert.equal((await attempt('admin-pass-123')).status, 429)
  })

  test('each endpoint has its own request limiter, so sign-in traffic cannot exhaust registration or reset budgets', () => {
    const { loginLimiter, adminLoginLimiter, registerLimiter, forgotPasswordLimiter, resetPasswordLimiter } = limiters
    const all = [loginLimiter, adminLoginLimiter, registerLimiter, forgotPasswordLimiter, resetPasswordLimiter]
    assert.equal(new Set(all).size, all.length)
    assert.equal(limiters.authLimiter, undefined)
  })
})

describe('sign-in timing does not reveal which emails are registered', () => {
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const time = async attempt => { const start = process.hrtime.bigint(); await attempt(); return Number(process.hrtime.bigint() - start) / 1e6 }

  test('unknown email, Argon2id account and bcrypt account all take about the same time', async () => {
    await Member.create({ name: 'Timing Argon', email: 'timing-argon@example.com', phone: '+92 300 5550111', password: 'argon-pass-9876' })
    const bcryptMember = await Member.create({ name: 'Timing Bcrypt', email: 'timing-bcrypt@example.com', phone: '+92 300 5550112', password: 'placeholder-pass-1' })
    await Member.updateOne({ _id: bcryptMember._id }, { $set: { password: await bcrypt.hash('bcrypt-pass-9876', 12) } })

    await login('warm-up-attempt', 'timing-argon@example.com')
    const samples = { unknown: [], argon: [], bcrypt: [] }
    for (let i = 0; i < 3; i += 1) {
      samples.unknown.push(await time(() => login('wrong-password-1', `nobody-${i}@example.com`)))
      samples.argon.push(await time(() => login('wrong-password-1', 'timing-argon@example.com')))
      samples.bcrypt.push(await time(() => login('wrong-password-1', 'timing-bcrypt@example.com')))
    }
    const [unknown, argon, bcryptTime] = [median(samples.unknown), median(samples.argon), median(samples.bcrypt)]
    const slowest = Math.max(unknown, argon, bcryptTime)
    const fastest = Math.min(unknown, argon, bcryptTime)
    assert.ok(slowest > 100, `sanity: verification really ran (slowest ${slowest.toFixed(0)} ms)`)
    assert.ok(fastest / slowest > 0.6, `timings diverge: unknown ${unknown.toFixed(0)} ms, argon ${argon.toFixed(0)} ms, bcrypt ${bcryptTime.toFixed(0)} ms`)
  })
})
