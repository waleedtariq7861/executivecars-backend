process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'development'
process.env.ENABLE_DEMO_SEED = 'true'
process.env.ENABLE_HOSTED_DEMO_MEMBERSHIP = 'false'
const { DEFAULT_TEST_URI, validateTestUri, connectTestDatabase, dropTestDatabase, resetTestDatabase } = require('./helpers/localDatabase')
process.env.MONGO_URI = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GROQ_API_KEY', 'ML_SERVICE_KEY', 'RESEND_API_KEY']) process.env[key] = ''

const { before, after, beforeEach, test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const crypto = require('node:crypto')
const mongoose = require('mongoose')
require('./helpers/noRateLimits')
const request = require('supertest')
require('./helpers/cookieAuth')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const Member = require('../src/models/Member')
const Session = require('../src/models/Session')
const PasswordResetToken = require('../src/models/PasswordResetToken')
const sessions = require('../src/utils/sessions')
const { attachSession } = require('../src/utils/session')
const { deriveKey, hmac, sha256 } = require('../src/utils/crypto')
const { validateRuntimeConfig } = require('../src/config/runtime')
const initSocket = require('../src/socket/bidSocket')

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
  app.set('io', undefined)
})

const DAY = 86_400_000
const person = { name: 'Session Tester', email: 'session@example.com', phone: '+92 300 5550101', password: 'test-pass-123' }

const register = async () => {
  const response = await request(app).post('/api/auth/register').send(person)
  assert.equal(response.status, 201)
  return response.body
}
const login = async (password = person.password) => {
  const response = await request(app).post('/api/auth/login').send({ email: person.email, password })
  assert.equal(response.status, 200)
  return response.body
}
const asBearer = token => ({ Authorization: `Bearer ${token}` })
const sessionStatus = token => request(app).get('/api/auth/session').set(asBearer(token))
const fakeIo = () => {
  const calls = []
  return { calls, in: room => ({ disconnectSockets: closeConnection => calls.push({ room, closeConnection }) }) }
}

test('sign-in stores only a hash of the session token, with customer lifetimes', async () => {
  const { token } = await register()
  const stored = await Session.findOne()
  assert.ok(token.length >= 40)
  assert.equal(stored.tokenHash, sha256(token))
  assert.notEqual(stored.tokenHash, token)
  assert.equal(stored.role, 'user')
  assert.equal(stored.accountModel, 'member')
  assert.ok(Math.abs(stored.idleExpiresAt - stored.createdAt - 7 * DAY) < 5_000)
  assert.ok(Math.abs(stored.absoluteExpiresAt - stored.createdAt - 14 * DAY) < 5_000)
  assert.equal(stored.expireAt.getTime(), stored.absoluteExpiresAt.getTime())
})

test('administrator sessions are much shorter than customer sessions', async () => {
  await Admin.create({ name: 'Session Admin', email: 'session-admin@example.com', password: 'admin-pass-123', role: 'admin' })
  const response = await request(app).post('/api/auth/admin/login').send({ email: 'session-admin@example.com', password: 'admin-pass-123' })
  assert.equal(response.status, 200)
  const stored = await Session.findOne()
  assert.equal(stored.role, 'admin')
  assert.ok(Math.abs(stored.idleExpiresAt - stored.createdAt - 30 * 60_000) < 5_000)
  assert.ok(Math.abs(stored.absoluteExpiresAt - stored.createdAt - 8 * 3_600_000) < 5_000)
})

test('idle and absolute timeouts end a session with a specific code', async () => {
  const { token } = await register()
  assert.equal((await sessionStatus(token)).status, 200)

  await Session.updateOne({}, { idleExpiresAt: new Date(Date.now() - 1000) })
  const idle = await sessionStatus(token)
  assert.equal(idle.status, 401)
  assert.equal(idle.body.code, 'SESSION_EXPIRED')

  await Session.updateOne({}, { idleExpiresAt: new Date(Date.now() + DAY), absoluteExpiresAt: new Date(Date.now() - 1000) })
  const absolute = await sessionStatus(token)
  assert.equal(absolute.status, 401)
  assert.equal(absolute.body.code, 'SESSION_EXPIRED')
})

test('activity slides the idle window but never beyond the absolute limit', async () => {
  const { token } = await register()
  const soon = new Date(Date.now() + 60_000)
  await Session.updateOne({}, { lastSeenAt: new Date(Date.now() - 5 * 60_000), idleExpiresAt: soon })
  assert.equal((await sessionStatus(token)).status, 200)
  const slid = await Session.findOne()
  assert.ok(slid.idleExpiresAt.getTime() > Date.now() + 6 * DAY)

  await Session.updateOne({}, { lastSeenAt: new Date(Date.now() - 5 * 60_000), idleExpiresAt: soon, absoluteExpiresAt: new Date(Date.now() + 2 * 3_600_000) })
  await sessionStatus(token)
  const capped = await Session.findOne()
  assert.equal(capped.idleExpiresAt.getTime(), capped.absoluteExpiresAt.getTime())
})

test('logout revokes the session on the server, not just the cookie', async () => {
  const { token, csrfToken } = await register()
  const out = await request(app).post('/api/auth/logout')
    .set('Cookie', `ec_session=${token}`).set('Origin', process.env.CLIENT_URL).set('X-CSRF-Token', csrfToken)
  assert.equal(out.status, 200)
  assert.match(out.headers['set-cookie'][0], /ec_session=;/)

  // The cookie is gone from the browser, but a copied token must be dead as well.
  const replay = await sessionStatus(token)
  assert.equal(replay.status, 401)
  assert.equal(replay.body.code, 'SESSION_REVOKED')
  assert.equal((await Session.findOne()).revokedReason, 'logout')
})

test('logout can always clear a stale or unverifiable cookie, but only for allowed origins', async () => {
  const stale = await request(app).post('/api/auth/logout')
    .set('Cookie', 'ec_session=not-a-real-session').set('Origin', process.env.CLIENT_URL)
  assert.equal(stale.status, 200)
  assert.match(stale.headers['set-cookie'][0], /ec_session=;/)

  const foreign = await request(app).post('/api/auth/logout')
    .set('Cookie', 'ec_session=not-a-real-session').set('Origin', 'https://evil.example')
  assert.equal(foreign.status, 403)

  const noOrigin = await request(app).post('/api/auth/logout').set('Cookie', 'ec_session=not-a-real-session')
  assert.equal(noOrigin.status, 403)

  const anonymous = await request(app).post('/api/auth/logout')
  assert.equal(anonymous.status, 200)
})

test('changing the password signs out every other session but keeps the current one', async () => {
  const first = await register()
  const second = await login()
  const io = fakeIo()
  app.set('io', io)

  const change = await request(app).post('/api/auth/change-password').set(asBearer(first.token))
    .send({ current: person.password, newPassword: 'brand-new-pass-456' })
  assert.equal(change.status, 200)

  assert.equal((await sessionStatus(first.token)).status, 200)
  const other = await sessionStatus(second.token)
  assert.equal(other.status, 401)
  assert.equal(other.body.code, 'SESSION_REVOKED')
  const revoked = await Session.findOne({ tokenHash: sha256(second.token) })
  assert.equal(revoked.revokedReason, 'password_changed')
  // sockets opened with the revoked session are cut off
  assert.deepEqual(io.calls, [{ room: `session-${revoked._id}`, closeConnection: true }])
})

test('a failed password change leaves every session alone', async () => {
  const first = await register()
  const second = await login()
  const wrong = await request(app).post('/api/auth/change-password').set(asBearer(first.token))
    .send({ current: 'not-the-password', newPassword: 'brand-new-pass-456' })
  assert.equal(wrong.status, 400)
  assert.equal((await sessionStatus(first.token)).status, 200)
  assert.equal((await sessionStatus(second.token)).status, 200)
})

test('resetting a forgotten password signs the account out everywhere', async () => {
  const first = await register()
  const second = await login()
  const member = await Member.findOne({ email: person.email })
  const rawToken = crypto.randomBytes(32).toString('hex')
  await PasswordResetToken.create({ accountModel: 'member', accountId: member._id, tokenHash: sha256(rawToken), expiresAt: new Date(Date.now() + 60_000) })

  const reset = await request(app).post('/api/auth/reset-password').send({ token: rawToken, password: 'reset-pass-789' })
  assert.equal(reset.status, 200)
  for (const { token } of [first, second]) {
    const response = await sessionStatus(token)
    assert.equal(response.status, 401)
    assert.equal(response.body.code, 'SESSION_REVOKED')
  }
  assert.equal((await request(app).post('/api/auth/login').send({ email: person.email, password: 'reset-pass-789' })).status, 200)
})

test('tokens that are not server sessions are rejected, including look-alike JWTs and deleted accounts', async () => {
  const { token } = await register()
  const jwtLookalike = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEiLCJyb2xlIjoidXNlciJ9.c2lnbmF0dXJl'
  const forged = await request(app).get('/api/auth/session').set('Cookie', `ec_session=${jwtLookalike}`)
  assert.equal(forged.status, 401)
  assert.equal(forged.body.code, 'NOT_AUTHENTICATED')

  await Member.deleteOne({ email: person.email })
  const orphan = await sessionStatus(token)
  assert.equal(orphan.status, 401)
  assert.equal(orphan.body.code, 'NOT_AUTHENTICATED')
  assert.equal((await Session.findOne()).revokedReason, 'account_missing')
})

test('revoking a session disconnects exactly its sockets', async () => {
  await register()
  const stored = await Session.findOne()
  const io = fakeIo()
  await sessions.revokeSession(stored, 'test', io)
  assert.deepEqual(io.calls, [{ room: `session-${stored._id}`, closeConnection: true }])
  assert.equal(await sessions.isSessionActive(stored._id), false)
})

test('session cookies are HttpOnly, Strict, and Secure in production', () => {
  const capture = () => { const call = {}; return { call, cookie(name, value, options) { Object.assign(call, { name, value, options }) } } }
  const development = capture()
  attachSession(development, 'token', 1000)
  assert.equal(development.call.options.httpOnly, true)
  assert.equal(development.call.options.sameSite, 'strict')
  assert.equal(development.call.options.secure, false)
  assert.equal(development.call.options.path, '/')

  const previous = { NODE_ENV: process.env.NODE_ENV, SESSION_COOKIE_SAMESITE: process.env.SESSION_COOKIE_SAMESITE }
  try {
    process.env.NODE_ENV = 'production'
    const production = capture()
    attachSession(production, 'token', 1000)
    assert.equal(production.call.options.secure, true)
    process.env.SESSION_COOKIE_SAMESITE = 'lax'
    const lax = capture()
    attachSession(lax, 'token', 1000)
    assert.equal(lax.call.options.sameSite, 'lax')
  } finally {
    process.env.NODE_ENV = previous.NODE_ENV
    if (previous.SESSION_COOKIE_SAMESITE === undefined) delete process.env.SESSION_COOKIE_SAMESITE
    else process.env.SESSION_COOKIE_SAMESITE = previous.SESSION_COOKIE_SAMESITE
  }
})

test('production uses the __Host- cookie name and development the plain name', () => {
  const name = env => spawnSync(process.execPath, ['-e', "console.log(require('./src/utils/session').sessionCookieName())"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, ...env }, encoding: 'utf8',
  }).stdout.trim()
  assert.equal(name({ NODE_ENV: 'production' }), '__Host-ec_session')
  assert.equal(name({ NODE_ENV: 'development' }), 'ec_session')
})

test('one application secret yields independent keys for CSRF, OTP and documents', () => {
  assert.notDeepEqual(deriveKey('csrf'), deriveKey('otp'))
  assert.notDeepEqual(deriveKey('otp'), deriveKey('document'))
  assert.notEqual(hmac('document', 'same-input'), hmac('csrf', 'same-input'))
  assert.equal(hmac('document', 'same-input'), hmac('document', 'same-input'))
  assert.notEqual(hmac('csrf', 'a'), hmac('csrf', 'b'))
})

test('invalid session settings are rejected at startup', () => {
  const base = { NODE_ENV: 'test', APP_MODE: 'demo', EMAIL_DELIVERY_MODE: 'development' }
  assert.doesNotThrow(() => validateRuntimeConfig({ ...base, SESSION_CUSTOMER_IDLE_DAYS: '7', SESSION_COOKIE_SAMESITE: 'Lax' }))
  assert.throws(() => validateRuntimeConfig({ ...base, SESSION_CUSTOMER_IDLE_DAYS: '0' }), /SESSION_CUSTOMER_IDLE_DAYS/)
  assert.throws(() => validateRuntimeConfig({ ...base, SESSION_ADMIN_ABSOLUTE_HOURS: 'soon' }), /SESSION_ADMIN_ABSOLUTE_HOURS/)
  assert.throws(() => validateRuntimeConfig({ ...base, SESSION_COOKIE_SAMESITE: 'none' }), /SESSION_COOKIE_SAMESITE/)
})

test('sockets authenticate with the real session store: revoked and expired sessions are refused', async () => {
  const { token } = await register()
  await Member.updateOne({ email: person.email }, { subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + DAY) })
  const io = { use(handler) { this.authenticate = handler }, on() {} }
  initSocket(io)
  const connect = value => new Promise(resolve => io.authenticate({ handshake: { headers: { cookie: `ec_session=${value}` }, auth: {} } }, resolve))

  assert.equal(await connect(token), undefined)

  await Session.updateOne({}, { idleExpiresAt: new Date(Date.now() - 1000) })
  assert.match((await connect(token)).message, /Invalid token/)

  await Session.updateOne({}, { idleExpiresAt: new Date(Date.now() + DAY), revokedAt: new Date() })
  assert.match((await connect(token)).message, /Invalid token/)
  assert.match((await connect('not-a-session')).message, /Invalid token/)
})
