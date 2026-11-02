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
const mongoose = require('mongoose')
require('./helpers/noRateLimits')
const request = require('supertest')
require('./helpers/cookieAuth')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const AuthEvent = require('../src/models/AuthEvent')
const Member = require('../src/models/Member')
const Session = require('../src/models/Session')
const email = require('../src/utils/email')
const { sha256 } = require('../src/utils/crypto')
const { describeDevice } = require('../src/utils/device')
const { maskEmail } = require('../src/utils/authEvents')
const { sendInBackground } = require('../src/utils/background')
const { requestResetCode } = require('./helpers/resetCode')

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

const original = { changed: email.sendPasswordChangedEmail, reset: email.sendPasswordResetCodeEmail, verify: email.sendVerificationCodeEmail }
beforeEach(async () => {
  await resetTestDatabase()
  email.sendPasswordChangedEmail = async () => {}
  email.sendPasswordResetCodeEmail = async () => {}
  email.sendVerificationCodeEmail = async () => {}
})
afterEach(() => {
  email.sendPasswordChangedEmail = original.changed
  email.sendPasswordResetCodeEmail = original.reset
  email.sendVerificationCodeEmail = original.verify
})

const person = { name: 'Security Tester', email: 'security@example.com', phone: '+92 300 5550301', password: 'orchid-lantern-42' }
const other = { name: 'Someone Else', email: 'someone-else@example.com', phone: '+92 300 5550302', password: 'orchid-lantern-43' }
const asBearer = token => ({ Authorization: `Bearer ${token}` })
const register = async (account = person) => (await request(app).post('/api/auth/register').send(account)).body
const login = async (account = person, agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36') =>
  (await request(app).post('/api/auth/login').set('User-Agent', agent).send({ email: account.email, password: account.password })).body
const adminLogin = async () => {
  await Admin.create({ name: 'Security Admin', email: 'security-admin@example.com', password: 'admin-pass-123', role: 'admin' })
  return (await request(app).post('/api/auth/admin/login').send({ email: 'security-admin@example.com', password: 'admin-pass-123' })).body
}
const events = (filter = {}) => AuthEvent.find(filter).sort({ createdAt: 1 }).lean()
const types = async (filter = {}) => (await events(filter)).map(event => event.type)

describe('recording security events', () => {
  test('sign-up, sign-in, sign-out and password changes are recorded against the account', async () => {
    const { token } = await register()
    const member = await Member.findOne({ email: person.email })
    await request(app).post('/api/auth/logout').set(asBearer(token))
    const second = await login()
    const change = await request(app).post('/api/auth/change-password').set(asBearer(second.token))
      .send({ current: person.password, newPassword: 'violet-harbour-77' })
    assert.equal(change.status, 200)

    assert.deepEqual(await types(), ['registered', 'logout', 'login_success', 'password_changed'])
    for (const event of await events()) {
      assert.equal(event.accountModel, 'member')
      assert.equal(String(event.accountId), String(member._id))
    }
  })

  test('the address is stored masked and nothing secret ever reaches the trail', async () => {
    const { token } = await register()
    await request(app).post('/api/auth/change-password').set(asBearer(token)).send({ current: person.password, newPassword: 'violet-harbour-77' })
    const { code } = await requestResetCode(app, person.email)
    await request(app).post('/api/auth/reset-password').send({ email: person.email, code, password: 'amber-meadow-58' })
    const dump = JSON.stringify(await events())
    assert.ok(!dump.includes(person.email), 'the full address must not be stored')
    assert.match(dump, /s\*\*\*@example\.com/)
    for (const secret of [person.password, 'violet-harbour-77', 'amber-meadow-58', token, code]) assert.ok(!dump.includes(secret))
    assert.equal(maskEmail('Name@Example.com'), 'n***@example.com')
    assert.equal(maskEmail('not-an-address'), undefined)
  })

  test('signing out twice with the same session records one sign-out', async () => {
    const { token } = await register()
    await request(app).post('/api/auth/logout').set(asBearer(token))
    await request(app).post('/api/auth/logout').set(asBearer(token))
    assert.equal(await AuthEvent.countDocuments({ type: 'logout' }), 1)
  })

  test('failed sign-ins are recorded for a real account only, so made-up addresses cannot fill the trail', async () => {
    await register()
    await request(app).post('/api/auth/login').send({ email: person.email, password: 'wrong-password-1' })
    await request(app).post('/api/auth/login').send({ email: 'nobody-here@example.com', password: 'wrong-password-1' })
    const failures = await events({ type: 'login_failure' })
    assert.equal(failures.length, 1)
    assert.equal(failures[0].accountModel, 'member')
  })

  test('administrator sign-ins and failures are recorded too', async () => {
    await Admin.create({ name: 'Security Admin', email: 'security-admin@example.com', password: 'admin-pass-123', role: 'admin' })
    await request(app).post('/api/auth/admin/login').send({ email: 'security-admin@example.com', password: 'wrong-password-1' })
    await request(app).post('/api/auth/admin/login').send({ email: 'security-admin@example.com', password: 'admin-pass-123' })
    assert.deepEqual((await events()).map(event => [event.type, event.accountModel]), [['login_failure', 'admin'], ['login_success', 'admin']])
  })

  test('a reset request is recorded only for a real account; completing it is recorded too', async () => {
    await register()
    await requestResetCode(app, 'nobody-here@example.com')
    assert.equal(await AuthEvent.countDocuments({ type: 'reset_requested' }), 0)
    const { code } = await requestResetCode(app, person.email)
    await request(app).post('/api/auth/reset-password').send({ email: person.email, code, password: 'amber-meadow-58' })
    assert.deepEqual(await types({ type: { $in: ['reset_requested', 'reset_completed'] } }), ['reset_requested', 'reset_completed'])
  })

  test('verifying the e-mail address is recorded', async () => {
    let received
    email.sendVerificationCodeEmail = async (to, details) => { received = details.code }
    const { token } = await register()
    assert.match(received, /^\d{6}$/)
    const verify = await request(app).post('/api/auth/email/verify').set(asBearer(token)).send({ code: received })
    assert.equal(verify.status, 200)
    assert.equal(await AuthEvent.countDocuments({ type: 'email_verified' }), 1)
  })

  test('a failure to write the audit trail never breaks the action, and is reported on the server log', async t => {
    await register()
    const logged = []
    t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')))
    t.mock.method(AuthEvent, 'create', async () => { throw new Error('audit store down') })
    const response = await request(app).post('/api/auth/login').send({ email: person.email, password: person.password })
    assert.equal(response.status, 200)
    assert.ok(logged.some(line => line.includes('login_success') && line.includes('audit store down')))
  })

  test('events expire on their own after about six months', async () => {
    await AuthEvent.init()
    const index = (await AuthEvent.collection.indexes()).find(item => item.key.createdAt === 1 && item.expireAfterSeconds !== undefined)
    assert.ok(index, 'there should be a TTL index on createdAt')
    assert.equal(index.expireAfterSeconds, 180 * 24 * 60 * 60)
  })
})

describe('mail that could not be delivered', () => {
  test('a failing reset-code mail is recorded for administrators and the requester still gets the neutral answer', async () => {
    await register()
    email.sendPasswordResetCodeEmail = async () => { throw new Error('provider down') }
    const response = await request(app).post('/api/auth/forgot-password').send({ email: person.email })
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody-here@example.com' })
    assert.deepEqual(response.body, unknown.body)
    await new Promise(resolve => setTimeout(resolve, 50))
    const failed = await events({ type: 'mail_failed' })
    assert.equal(failed.length, 1)
    assert.equal(failed[0].detail, 'password reset code')
    assert.equal(failed[0].accountModel, 'member')
  })

  test('a failing password-changed notice is recorded after a change and after a reset', async () => {
    const { token } = await register()
    email.sendPasswordChangedEmail = async () => { throw new Error('provider down') }
    const change = await request(app).post('/api/auth/change-password').set(asBearer(token)).send({ current: person.password, newPassword: 'violet-harbour-77' })
    assert.equal(change.status, 200)
    const { code } = await requestResetCode(app, person.email)
    const done = await request(app).post('/api/auth/reset-password').send({ email: person.email, code, password: 'amber-meadow-58' })
    assert.equal(done.status, 200)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual((await events({ type: 'mail_failed' })).map(event => event.detail), ['password changed notice', 'password changed notice'])
  })

  test('a verification code that could not be mailed is recorded', async () => {
    email.sendVerificationCodeEmail = async () => { throw new Error('provider down') }
    const response = await request(app).post('/api/auth/register').send(person)
    assert.equal(response.status, 201)
    assert.equal(response.body.verification.failed, true)
    const failed = await events({ type: 'mail_failed' })
    assert.deepEqual(failed.map(event => event.detail), ['verification code'])
  })

  test('sendInBackground hands a failure to its hook, whether it rejects or throws, and survives a broken hook', async t => {
    const logged = []
    t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')))
    const seen = []
    sendInBackground('One', async () => { throw new Error('async failure') }, error => seen.push(error.message))
    sendInBackground('Two', () => { throw new Error('sync failure') }, error => seen.push(error.message))
    sendInBackground('Three', async () => { throw new Error('boom') }, () => { throw new Error('hook broke') })
    sendInBackground('Four', async () => { throw new Error('boom') }, async () => { throw new Error('async hook broke') })
    sendInBackground('Five', async () => 'fine', () => seen.push('never'))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual([...seen].sort(), ['async failure', 'sync failure'])
    assert.ok(logged.some(line => line.includes('Three failure hook failed') && line.includes('hook broke')))
    assert.ok(logged.some(line => line.includes('Four failure hook failed') && line.includes('async hook broke')))
  })
})

describe('your own sessions', () => {
  test('lists every live session, marks the current one and describes the device', async () => {
    const first = await register()
    const second = await login(person, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17 Safari/604')
    const response = await request(app).get('/api/auth/sessions').set(asBearer(second.token))
    assert.equal(response.status, 200)
    assert.equal(response.body.sessions.length, 2)
    const current = response.body.sessions.find(item => item.current)
    assert.equal(current.device, 'Safari on iOS')
    const sessionOfFirst = response.body.sessions.find(item => !item.current)
    assert.equal(sessionOfFirst.id, String((await Session.findOne({ role: 'user' }).sort({ createdAt: 1 }))._id))
    assert.ok(first.token)
    for (const item of response.body.sessions) {
      assert.ok(item.signedInAt && item.lastSeenAt && item.expiresAt)
      assert.equal(item.tokenHash, undefined)
    }
  })

  test('does not list ended, expired or other people\'s sessions', async () => {
    await register()
    const kept = await login()
    await register(other)
    const member = await Member.findOne({ email: person.email })
    const ended = await Session.findOne({ accountId: member._id }).sort({ createdAt: 1 })
    await Session.updateOne({ _id: ended._id }, { $set: { revokedAt: new Date() } })
    const idle = await login()
    await Session.updateOne({ tokenHash: sha256(idle.token) }, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } })
    const list = await request(app).get('/api/auth/sessions').set(asBearer(kept.token))
    assert.equal(list.body.sessions.length, 1)
    assert.equal(list.body.sessions[0].current, true)
  })

  test('requires a signed-in session', async () => {
    assert.equal((await request(app).get('/api/auth/sessions')).status, 401)
    assert.equal((await request(app).get('/api/auth/activity')).status, 401)
    assert.equal((await request(app).post('/api/auth/sessions/revoke-others')).status, 401)
  })

  test('signs one other session out, which then fails with SESSION_REVOKED, and records it', async () => {
    const first = await register()
    const second = await login()
    const target = await Session.findOne({}).sort({ createdAt: 1 })
    const done = await request(app).delete(`/api/auth/sessions/${target._id}`).set(asBearer(second.token))
    assert.equal(done.status, 200)
    assert.equal(done.body.revoked, 1)
    const after = await request(app).get('/api/auth/session').set(asBearer(first.token))
    assert.equal(after.status, 401)
    assert.equal(after.body.code, 'SESSION_REVOKED')
    assert.equal((await request(app).get('/api/auth/session').set(asBearer(second.token))).status, 200)
    assert.equal((await Session.findById(target._id)).revokedReason, 'user_revoked')
    assert.deepEqual((await events({ type: 'session_revoked' })).map(event => event.detail), ['one other session'])
  })

  test('refuses to end the session in use, an unknown session, a malformed id and someone else\'s session', async () => {
    const mine = await register()
    const theirs = await register(other)
    const current = await Session.findOne({ accountId: (await Member.findOne({ email: person.email }))._id })
    const own = await request(app).delete(`/api/auth/sessions/${current._id}`).set(asBearer(mine.token))
    assert.equal(own.status, 400)
    assert.equal(own.body.code, 'CURRENT_SESSION')
    const foreign = await Session.findOne({ accountId: (await Member.findOne({ email: other.email }))._id })
    assert.equal((await request(app).delete(`/api/auth/sessions/${foreign._id}`).set(asBearer(mine.token))).status, 404)
    assert.equal((await Session.findById(foreign._id)).revokedAt, undefined, 'another person\'s session must stay')
    assert.equal((await request(app).delete(`/api/auth/sessions/${new mongoose.Types.ObjectId()}`).set(asBearer(mine.token))).status, 404)
    assert.equal((await request(app).delete('/api/auth/sessions/not-an-id').set(asBearer(mine.token))).status, 404)
    assert.equal((await request(app).get('/api/auth/session').set(asBearer(theirs.token))).status, 200)
  })

  test('an ended session cannot be ended again', async () => {
    await register()
    const second = await login()
    const target = await Session.findOne({}).sort({ createdAt: 1 })
    assert.equal((await request(app).delete(`/api/auth/sessions/${target._id}`).set(asBearer(second.token))).status, 200)
    assert.equal((await request(app).delete(`/api/auth/sessions/${target._id}`).set(asBearer(second.token))).status, 404)
  })

  test('signs every other session out and keeps the current one', async () => {
    const first = await register()
    const second = await login()
    const third = await login()
    const other1 = await register(other)
    const done = await request(app).post('/api/auth/sessions/revoke-others').set(asBearer(third.token))
    assert.equal(done.status, 200)
    assert.equal(done.body.revoked, 2)
    assert.equal((await request(app).get('/api/auth/session').set(asBearer(third.token))).status, 200)
    for (const gone of [first, second]) {
      const check = await request(app).get('/api/auth/session').set(asBearer(gone.token))
      assert.equal(check.status, 401)
      assert.equal(check.body.code, 'SESSION_REVOKED')
    }
    assert.equal((await request(app).get('/api/auth/session').set(asBearer(other1.token))).status, 200, 'other accounts are untouched')
    assert.deepEqual((await events({ type: 'session_revoked' })).map(event => event.detail), ['2 other sessions'])

    const again = await request(app).post('/api/auth/sessions/revoke-others').set(asBearer(third.token))
    assert.equal(again.body.revoked, 0)
    assert.equal(await AuthEvent.countDocuments({ type: 'session_revoked' }), 1, 'nothing to end means nothing to record')
  })

  test('an administrator manages their own sessions the same way', async () => {
    const admin = await adminLogin()
    const list = await request(app).get('/api/auth/sessions').set(asBearer(admin.token))
    assert.equal(list.status, 200)
    assert.equal(list.body.sessions.length, 1)
    assert.equal(list.body.sessions[0].current, true)
  })
})

describe('your own recent activity', () => {
  test('shows only your events, newest first, with a device but without an address or account id', async () => {
    const mine = await register()
    await register(other)
    await login(person, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Firefox/121.0')
    const response = await request(app).get('/api/auth/activity').set(asBearer(mine.token))
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.events.map(event => event.type), ['login_success', 'registered'])
    assert.equal(response.body.events[0].device, 'Firefox on macOS')
    for (const event of response.body.events) {
      assert.equal(event.email, undefined)
      assert.equal(event.accountId, undefined)
      assert.equal(event.userAgent, undefined)
    }
  })

  test('is capped at the most recent thirty', async () => {
    const mine = await register()
    const member = await Member.findOne({ email: person.email })
    await AuthEvent.insertMany(Array.from({ length: 40 }, () => ({ type: 'login_success', accountModel: 'member', accountId: member._id })))
    const response = await request(app).get('/api/auth/activity').set(asBearer(mine.token))
    assert.equal(response.body.events.length, 30)
  })
})

describe('the administrators\' view', () => {
  test('is for administrators only', async () => {
    const member = await register()
    assert.equal((await request(app).get('/api/admin/auth-events')).status, 401)
    assert.equal((await request(app).get('/api/admin/auth-events').set(asBearer(member.token))).status, 403)
  })

  test('lists events with the account behind them and 24-hour counts of failures, mail problems and resets', async () => {
    await register()
    await request(app).post('/api/auth/login').send({ email: person.email, password: 'wrong-password-1' })
    email.sendPasswordResetCodeEmail = async () => { throw new Error('provider down') }
    await request(app).post('/api/auth/forgot-password').send({ email: person.email })
    await new Promise(resolve => setTimeout(resolve, 50))
    const admin = await adminLogin()
    const response = await request(app).get('/api/admin/auth-events').set(asBearer(admin.token))
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.summary, { loginFailures24h: 1, mailFailures24h: 1, resetRequests24h: 1 })
    const failure = response.body.events.find(event => event.type === 'login_failure')
    assert.equal(failure.account.name, person.name)
    assert.equal(failure.account.email, person.email)
    assert.equal(failure.email, 's***@example.com')
    assert.equal(failure.accountModel, 'member')
    assert.equal(response.body.events[0].at >= response.body.events.at(-1).at, true, 'newest first')
  })

  test('the 24-hour counts leave out older events', async () => {
    await register()
    const member = await Member.findOne({ email: person.email })
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await AuthEvent.insertMany(['login_failure', 'mail_failed', 'reset_requested'].map(type => ({ type, accountModel: 'member', accountId: member._id, createdAt: old })))
    const admin = await adminLogin()
    const response = await request(app).get('/api/admin/auth-events').set(asBearer(admin.token))
    assert.deepEqual(response.body.summary, { loginFailures24h: 0, mailFailures24h: 0, resetRequests24h: 0 })
    assert.equal(response.body.events.filter(event => ['login_failure', 'mail_failed', 'reset_requested'].includes(event.type)).length, 3, 'the old events are still listed')
  })

  test('filters by event type, ignores an unknown type and clamps the limit', async () => {
    await register()
    const member = await Member.findOne({ email: person.email })
    await AuthEvent.insertMany([
      { type: 'login_failure', accountModel: 'member', accountId: member._id },
      { type: 'mail_failed', accountModel: 'member', accountId: member._id, detail: 'invoice' },
    ])
    const admin = await adminLogin()
    const only = await request(app).get('/api/admin/auth-events?type=mail_failed').set(asBearer(admin.token))
    assert.deepEqual(only.body.events.map(event => event.type), ['mail_failed'])
    assert.equal(only.body.events[0].detail, 'invoice')
    const unknown = await request(app).get('/api/admin/auth-events?type=%24where').set(asBearer(admin.token))
    assert.ok(unknown.body.events.length > 1)
    const limited = await request(app).get('/api/admin/auth-events?limit=1').set(asBearer(admin.token))
    assert.equal(limited.body.events.length, 1)
    await AuthEvent.insertMany(Array.from({ length: 210 }, () => ({ type: 'login_success', accountModel: 'member', accountId: member._id })))
    const huge = await request(app).get('/api/admin/auth-events?limit=999999').set(asBearer(admin.token))
    assert.equal(huge.status, 200)
    assert.equal(huge.body.events.length, 200, 'no more than 200 events in one answer')
    const plain = await request(app).get('/api/admin/auth-events').set(asBearer(admin.token))
    assert.equal(plain.body.events.length, 100, 'the default is 100')
  })

  test('shows an event whose account no longer exists without an account', async () => {
    await register()
    const gone = await Member.findOne({ email: person.email })
    await AuthEvent.create({ type: 'login_failure', accountModel: 'member', accountId: gone._id })
    await Member.deleteOne({ _id: gone._id })
    const admin = await adminLogin()
    const response = await request(app).get('/api/admin/auth-events?type=login_failure').set(asBearer(admin.token))
    assert.equal(response.body.events[0].account, null)
  })
})

describe('describing a device', () => {
  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 OPR/105', 'Opera on Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17 Mobile Safari/604', 'Safari on iOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 CriOS/120 Mobile Safari/604', 'Chrome on iOS'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Version/17 Safari/605', 'Safari on macOS'],
    ['curl/8.0', 'Browser on an unknown system'],
    ['', 'Unknown device'],
    [undefined, 'Unknown device'],
  ]
  for (const [agent, expected] of cases) test(`${agent || '(none)'} -> ${expected}`, () => assert.equal(describeDevice(agent), expected))
})
