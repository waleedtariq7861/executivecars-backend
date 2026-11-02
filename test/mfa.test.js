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
const { authenticator } = require('otplib')
require('./helpers/noRateLimits')
const request = require('supertest')
require('./helpers/cookieAuth')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const AdminMfa = require('../src/models/AdminMfa')
const AuthEvent = require('../src/models/AuthEvent')
const MfaChallenge = require('../src/models/MfaChallenge')
const LoginAttempt = require('../src/models/LoginAttempt')
const Member = require('../src/models/Member')
const Session = require('../src/models/Session')
const loginThrottle = require('../src/utils/loginThrottle')
const totp = require('../src/utils/totp')
const { MAX_CHALLENGE_ATTEMPTS } = require('../src/controllers/mfaController')

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

const PASSWORD = 'admin-pass-123'
const asBearer = token => ({ Authorization: `Bearer ${token}` })
// A code for the 30-second step `steps` away from now (0 = this step, 1 = the next one).
const codeAt = (secret, steps = 0) => authenticator.clone({ step: 30, digits: 6, window: 1, epoch: Date.now() + steps * 30_000 }).generate(secret)
const makeAdmin = (email = 'mfa-admin@example.com', name = 'Mfa Admin') => Admin.create({ name, email, password: PASSWORD, role: 'admin' })
const passwordStep = (email = 'mfa-admin@example.com', password = PASSWORD) => request(app).post('/api/auth/admin/login').send({ email, password })
const codeStep = (challenge, code) => request(app).post('/api/auth/admin/login/mfa').send({ challenge, code })
const signIn = async (email = 'mfa-admin@example.com') => (await passwordStep(email)).body

// Signs an administrator in without two-step sign-in and turns it on; returns what is needed to use it later.
const turnOn = async (email = 'mfa-admin@example.com', name = 'Mfa Admin') => {
  const admin = await makeAdmin(email, name)
  const { token } = await signIn(email)
  const setup = await request(app).post('/api/auth/mfa/setup').set(asBearer(token)).send({ password: PASSWORD })
  assert.equal(setup.status, 200)
  const enabled = await request(app).post('/api/auth/mfa/enable').set(asBearer(token)).send({ code: codeAt(setup.body.secret) })
  assert.equal(enabled.status, 200)
  return { admin, token, secret: setup.body.secret, recoveryCodes: enabled.body.recoveryCodes }
}
// The enabling code used up the current step; a sign-in test starts from a clean slate.
const forgetUsedStep = () => AdminMfa.updateMany({}, { $set: { lastUsedStep: 0 } })
const events = (filter = {}) => AuthEvent.find(filter).sort({ createdAt: 1 }).lean()

describe('the authenticator helpers', () => {
  test('a secret is 160 bits, base32 and encrypted with the account id bound in', () => {
    const secret = totp.newSecret()
    assert.match(secret, /^[A-Z2-7]{32}$/)
    const packed = totp.encryptSecret(secret, 'admin-1')
    assert.ok(!packed.includes(secret))
    assert.equal(totp.decryptSecret(packed, 'admin-1'), secret)
    assert.throws(() => totp.decryptSecret(packed, 'admin-2'), 'a ciphertext copied to another account must not decrypt')
    const tampered = `${packed.slice(0, -2)}${packed.endsWith('AA') ? 'BB' : 'AA'}`
    assert.throws(() => totp.decryptSecret(tampered, 'admin-1'))
    assert.notEqual(totp.encryptSecret(secret, 'admin-1'), packed, 'every encryption uses a fresh IV')
  })

  test('codes follow RFC 6238 and are accepted one step either side only', () => {
    const secret = totp.newSecret()
    const step = Math.floor(Date.now() / 30_000)
    assert.equal(totp.stepForCode(secret, codeAt(secret, 0)), step)
    assert.equal(totp.stepForCode(secret, codeAt(secret, 1)), step + 1)
    assert.equal(totp.stepForCode(secret, codeAt(secret, -1)), step - 1)
    assert.equal(totp.stepForCode(secret, codeAt(secret, 2)), null)
    assert.equal(totp.stepForCode(secret, codeAt(secret, -2)), null)
    for (const bad of ['', '12345', 'abcdef', '1234567', undefined]) assert.equal(totp.stepForCode(secret, bad), null)
  })

  test('recovery codes are ten look-alike-free characters, accepted in any case with or without the dash', () => {
    const { codes, hashed } = totp.newRecoveryCodes()
    assert.equal(codes.length, 8)
    assert.equal(new Set(codes).size, 8)
    for (const code of codes) assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/)
    assert.equal(totp.normalizeRecoveryCode(codes[0].toLowerCase()), codes[0].replace('-', ''))
    assert.equal(totp.normalizeRecoveryCode(` ${codes[0].replace('-', ' ')} `), codes[0].replace('-', ''))
    for (const bad of ['', '123456', 'ABCDE-FGHI', 'ABCDE-FGHIJK', 'ABCDE-0GHIJ', undefined, null]) assert.equal(totp.normalizeRecoveryCode(bad), null)
    assert.ok(hashed.every((item, index) => item.hash !== codes[index] && item.hash.length === 64))
    assert.equal(hashed[0].hash, totp.hashRecoveryCode(totp.normalizeRecoveryCode(codes[0])))
  })
})

describe('turning two-step sign-in on', () => {
  test('is for administrators only', async () => {
    const member = (await request(app).post('/api/auth/register').send({ name: 'A Customer', email: 'cust@example.com', phone: '+92 300 5550401', password: 'orchid-lantern-42' })).body
    for (const [method, path] of [['get', '/api/auth/mfa'], ['post', '/api/auth/mfa/setup'], ['post', '/api/auth/mfa/enable'], ['post', '/api/auth/mfa/disable'], ['post', '/api/auth/mfa/recovery-codes']]) {
      assert.equal((await request(app)[method](path)).status, 401, `${path} without a session`)
      assert.equal((await request(app)[method](path).set(asBearer(member.token))).status, 403, `${path} as a customer`)
    }
    assert.ok(await Member.exists({ email: 'cust@example.com' }))
  })

  test('starts only after the password is confirmed, then shows the secret and the QR address once', async () => {
    await makeAdmin()
    const { token } = await signIn()
    assert.deepEqual((await request(app).get('/api/auth/mfa').set(asBearer(token))).body, { enabled: false, recoveryCodesRemaining: 0 })
    const wrong = await request(app).post('/api/auth/mfa/setup').set(asBearer(token)).send({ password: 'not-the-password' })
    assert.equal(wrong.status, 400)
    assert.ok(wrong.body.errors.password)
    assert.equal(await AdminMfa.countDocuments(), 0)

    const setup = await request(app).post('/api/auth/mfa/setup').set(asBearer(token)).send({ password: PASSWORD })
    assert.equal(setup.status, 200)
    assert.match(setup.body.secret, /^[A-Z2-7]{32}$/)
    assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\/Executive%20Cars:mfa-admin%40example\.com\?secret=/)
    assert.equal(setup.headers['cache-control'], 'no-store')
    const stored = await AdminMfa.findOne().select('+pendingCipher +secretCipher')
    assert.ok(stored.pendingCipher && !stored.pendingCipher.includes(setup.body.secret), 'the pending secret is stored encrypted')
    assert.equal(stored.secretCipher, undefined)
    assert.equal(stored.enabledAt, undefined, 'nothing is on until a first code is confirmed')
    assert.equal((await request(app).get('/api/auth/mfa').set(asBearer(token))).body.enabled, false)
  })

  test('needs a correct first code; then it is on, shows eight recovery codes once, and stores only digests', async () => {
    await makeAdmin()
    const { token } = await signIn()
    assert.equal((await request(app).post('/api/auth/mfa/enable').set(asBearer(token)).send({ code: '123456' })).body.code, 'MFA_NOT_STARTED')
    const { body: { secret } } = await request(app).post('/api/auth/mfa/setup').set(asBearer(token)).send({ password: PASSWORD })

    const wrong = await request(app).post('/api/auth/mfa/enable').set(asBearer(token)).send({ code: codeAt(secret, 3) })
    assert.equal(wrong.status, 400)
    assert.equal(wrong.body.code, 'MFA_CODE_INVALID')
    assert.equal((await request(app).post('/api/auth/mfa/enable').set(asBearer(token)).send({ code: 'abcdef' })).status, 400)

    const on = await request(app).post('/api/auth/mfa/enable').set(asBearer(token)).send({ code: ` ${codeAt(secret).slice(0, 3)} ${codeAt(secret).slice(3)} ` })
    assert.equal(on.status, 200)
    assert.equal(on.body.enabled, true)
    assert.equal(on.body.recoveryCodes.length, 8)
    assert.equal(on.headers['cache-control'], 'no-store')

    const stored = await AdminMfa.findOne().select('+secretCipher +pendingCipher +recoveryCodes')
    assert.ok(stored.enabledAt)
    assert.equal(stored.pendingCipher, undefined)
    assert.equal(totp.decryptSecret(stored.secretCipher, stored.adminId), secret)
    assert.equal(stored.recoveryCodes.length, 8)
    assert.ok(JSON.stringify(stored.toObject()).split('"').every(piece => !on.body.recoveryCodes.includes(piece)), 'no recovery code is stored in the clear')
    assert.deepEqual((await request(app).get('/api/auth/mfa').set(asBearer(token))).body.recoveryCodesRemaining, 8)
    assert.deepEqual(await (await events({ type: 'mfa_enabled' })).map(event => event.accountModel), ['admin'])
  })

  test('signs the other devices out and refuses to start again while it is on', async () => {
    await makeAdmin()
    const elsewhere = await signIn()
    const { token } = await signIn()
    const { body: { secret } } = await request(app).post('/api/auth/mfa/setup').set(asBearer(token)).send({ password: PASSWORD })
    await request(app).post('/api/auth/mfa/enable').set(asBearer(token)).send({ code: codeAt(secret) })
    assert.equal((await request(app).get('/api/auth/session').set(asBearer(elsewhere.token))).status, 401)
    const mine = await request(app).get('/api/auth/session').set(asBearer(token))
    assert.equal(mine.status, 200)
    assert.equal(mine.body.user.mfaEnabled, true)
    const again = await request(app).post('/api/auth/mfa/setup').set(asBearer(token)).send({ password: PASSWORD })
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'MFA_ALREADY_ENABLED')
    assert.equal((await request(app).post('/api/auth/mfa/enable').set(asBearer(token)).send({ code: codeAt(secret, 1) })).status, 400)
  })

  test('an administrator without it signs in exactly as before and is told it is off', async () => {
    await makeAdmin()
    const response = await passwordStep()
    assert.equal(response.status, 200)
    assert.equal(response.body.mfaRequired, undefined)
    assert.equal(response.body.user.mfaEnabled, false)
    assert.ok(response.body.token)
  })
})

describe('signing in with the second factor', () => {
  test('the password alone gives a challenge, no session and no cookie', async () => {
    await turnOn()
    await Session.deleteMany({})
    const response = await passwordStep()
    assert.equal(response.status, 200)
    assert.equal(response.body.mfaRequired, true)
    assert.match(response.body.challenge, /^[A-Za-z0-9_-]{40,}$/)
    assert.equal(response.body.expiresInSeconds, 300)
    assert.equal(response.body.user, undefined)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(await Session.countDocuments(), 0)
    assert.equal((await MfaChallenge.findOne()).tokenHash === response.body.challenge, false, 'only a hash of the challenge is stored')
  })

  test('a wrong password still gets no challenge', async () => {
    await turnOn()
    const response = await passwordStep('mfa-admin@example.com', 'wrong-password-1')
    assert.equal(response.status, 401)
    assert.equal(response.body.challenge, undefined)
  })

  test('the password step does not reset the sign-in delay, so a stolen password cannot guess codes for free', async t => {
    await turnOn()
    const signInsBefore = (await events({ type: 'login_success' })).length
    const success = t.mock.method(loginThrottle, 'recordSuccess')
    await passwordStep()
    assert.equal(success.mock.callCount(), 0)
    assert.equal((await events({ type: 'login_success' })).length, signInsBefore, 'not a sign-in yet')
  })

  test('a current code finishes the sign-in with a session that remembers the second factor', async () => {
    const { secret } = await turnOn()
    await forgetUsedStep()
    await Session.deleteMany({})
    const { challenge } = await signIn()
    const done = await codeStep(challenge, codeAt(secret))
    assert.equal(done.status, 200)
    assert.deepEqual({ ...done.body.user, id: undefined }, { id: undefined, name: 'Mfa Admin', email: 'mfa-admin@example.com', role: 'admin', mfaEnabled: true })
    assert.ok(done.body.token && done.body.csrfToken)
    const session = await Session.findOne()
    assert.equal(session.role, 'admin')
    assert.ok(session.mfaVerifiedAt)
    assert.equal(await MfaChallenge.countDocuments(), 0)
    assert.equal((await request(app).get('/api/auth/session').set(asBearer(done.body.token))).status, 200)
    const signedIn = (await events({ type: 'login_success' })).at(-1)
    assert.equal(signedIn.detail, 'authenticator app')
  })

  test('a code works once: the same code cannot sign in again, even from a new challenge', async () => {
    const { secret } = await turnOn()
    await forgetUsedStep()
    const code = codeAt(secret)
    assert.equal((await codeStep((await signIn()).challenge, code)).status, 200)
    const replay = await codeStep((await signIn()).challenge, code)
    assert.equal(replay.status, 401)
    assert.equal(replay.body.code, 'MFA_CODE_INVALID')
  })

  test('an older step is refused once a newer one has been used', async () => {
    const { secret } = await turnOn()
    await forgetUsedStep()
    assert.equal((await codeStep((await signIn()).challenge, codeAt(secret, 1))).status, 200)
    assert.equal((await codeStep((await signIn()).challenge, codeAt(secret, 0))).status, 401)
  })

  test('a wrong code is refused, counted, recorded and slows the account down', async () => {
    const { secret } = await turnOn()
    await forgetUsedStep()
    const { challenge } = await signIn()
    const wrong = await codeStep(challenge, codeAt(secret, 3))
    assert.equal(wrong.status, 401)
    assert.equal(wrong.body.code, 'MFA_CODE_INVALID')
    assert.equal(wrong.headers['set-cookie'], undefined)
    assert.equal((await MfaChallenge.findOne()).attempts, 1)
    assert.equal((await events({ type: 'mfa_failed' })).length, 1)
    assert.equal(await Session.countDocuments({ mfaVerifiedAt: { $exists: true } }), 0)
  })

  test(`${MAX_CHALLENGE_ATTEMPTS} wrong guesses use the challenge up, even for the right code afterwards`, async () => {
    const { secret } = await turnOn()
    await forgetUsedStep()
    const { challenge } = await signIn()
    // The account's own sign-in delay would also start to answer 429 after a few misses; clear it so this test is
    // about the limit on the challenge itself.
    for (let i = 0; i < MAX_CHALLENGE_ATTEMPTS; i += 1) {
      await LoginAttempt.deleteMany({})
      assert.equal((await codeStep(challenge, '000000')).status, 401)
    }
    await LoginAttempt.deleteMany({})
    const late = await codeStep(challenge, codeAt(secret))
    assert.equal(late.status, 401)
    assert.equal(late.body.code, 'MFA_CHALLENGE_INVALID')
  })

  test('parallel guesses cannot exceed the attempt limit', async () => {
    const { secret } = await turnOn()
    await forgetUsedStep()
    const { challenge } = await signIn()
    await Promise.all(Array.from({ length: 12 }, () => codeStep(challenge, '000000')))
    assert.equal((await MfaChallenge.findOne()).attempts, MAX_CHALLENGE_ATTEMPTS)
    assert.equal((await codeStep(challenge, codeAt(secret))).status, 401)
  })

  test('a challenge works once, expires, is bound to its administrator, and unknown or malformed ones are refused', async () => {
    const first = await turnOn()
    const second = await turnOn('second-admin@example.com', 'Second Admin')
    await forgetUsedStep()

    const { challenge } = await signIn()
    assert.equal((await codeStep(challenge, codeAt(first.secret))).status, 200)
    assert.equal((await codeStep(challenge, codeAt(first.secret, 1))).body.code, 'MFA_CHALLENGE_INVALID', 'a spent challenge')

    await forgetUsedStep()
    const fresh = await signIn()
    await MfaChallenge.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal((await codeStep(fresh.challenge, codeAt(first.secret))).body.code, 'MFA_CHALLENGE_INVALID', 'an expired challenge')

    await forgetUsedStep()
    const mine = await signIn()
    const crossed = await codeStep(mine.challenge, codeAt(second.secret))
    assert.equal(crossed.status, 401, 'another administrator\'s code does not complete my challenge')

    assert.equal((await codeStep('a'.repeat(43), '123456')).body.code, 'MFA_CHALLENGE_INVALID')
    assert.equal((await codeStep('short', '123456')).status, 400)
    assert.equal((await codeStep(mine.challenge, '')).status, 400)
    assert.equal((await codeStep(mine.challenge, undefined)).status, 400)
    assert.equal((await request(app).post('/api/auth/admin/login/mfa').send({})).status, 400)
  })

  test('each administrator signs in with their own code, never with another\'s', async () => {
    const first = await turnOn()
    const second = await turnOn('second-admin@example.com', 'Second Admin')
    await forgetUsedStep()
    const own = await codeStep((await signIn('second-admin@example.com')).challenge, codeAt(second.secret, 1))
    assert.equal(own.status, 200, 'the second administrator\'s own code works')
    assert.equal(own.body.user.email, 'second-admin@example.com')
    await forgetUsedStep()
    const crossed = await codeStep((await signIn('second-admin@example.com')).challenge, codeAt(first.secret, 1))
    assert.equal(crossed.status, 401, 'the first administrator\'s code does not open the second\'s account')
  })

  test('a wrong code counts against the account like a wrong password, and slows the whole sign-in down after a few', async t => {
    await turnOn()
    await forgetUsedStep()
    const failures = t.mock.method(loginThrottle, 'recordFailure')
    assert.equal((await codeStep((await signIn()).challenge, '000000')).status, 401)
    assert.equal(failures.mock.callCount(), 1)
    assert.equal(failures.mock.calls[0].arguments[0], 'admin')
    assert.equal(failures.mock.calls[0].arguments[1].email, 'mfa-admin@example.com')

    failures.mock.restore()
    let slowedDown = false
    for (let i = 0; i < 12 && !slowedDown; i += 1) {
      const first = await passwordStep()
      if (first.status === 429) { slowedDown = true; break }
      slowedDown = (await codeStep(first.body.challenge, '000000')).status === 429
    }
    assert.ok(slowedDown, 'repeated wrong codes must start to be answered with a delay')
    const held = await passwordStep()
    assert.equal(held.status, 429, 'the delay holds the sign-in back even with the right password')
    assert.equal(held.body.code, 'LOGIN_THROTTLED')
  })

  test('a challenge for an administrator who no longer exists is refused', async () => {
    const { secret, admin } = await turnOn()
    await forgetUsedStep()
    const { challenge } = await signIn()
    await Admin.deleteOne({ _id: admin._id })
    assert.equal((await codeStep(challenge, codeAt(secret))).body.code, 'MFA_CHALLENGE_INVALID')
  })

  test('respects the sign-in delay of the account', async () => {
    const { secret } = await turnOn()
    await forgetUsedStep()
    const { challenge } = await signIn()
    for (let i = 0; i < 25; i += 1) await loginThrottle.recordFailure('admin', { ip: `198.51.100.${i}`, email: 'mfa-admin@example.com' })
    const response = await codeStep(challenge, codeAt(secret))
    assert.equal(response.status, 429)
    assert.equal(response.body.code, 'LOGIN_THROTTLED')
    assert.ok(Number(response.headers['retry-after']) > 0)
  })

  test('a finished sign-in clears the delay', async () => {
    const { secret } = await turnOn()
    await forgetUsedStep()
    await loginThrottle.recordFailure('admin', { ip: '127.0.0.1', email: 'mfa-admin@example.com' })
    const { challenge } = await signIn()
    assert.equal((await codeStep(challenge, codeAt(secret))).status, 200)
    assert.equal(await loginThrottle.check('admin', { ip: '127.0.0.1', email: 'mfa-admin@example.com' }), 0)
  })
})

describe('recovery codes', () => {
  test('sign in once each, in any case and without the dash, and the count goes down', async () => {
    const { recoveryCodes } = await turnOn()
    const used = recoveryCodes[0].toLowerCase().replace('-', ' ')
    const done = await codeStep((await signIn()).challenge, used)
    assert.equal(done.status, 200)
    assert.equal((await Session.findOne({ mfaVerifiedAt: { $exists: true } })).role, 'admin')
    assert.equal((await events({ type: 'recovery_code_used' })).at(-1).detail, '7 left')
    assert.equal((await events({ type: 'login_success' })).at(-1).detail, 'recovery code')
    const again = await codeStep((await signIn()).challenge, recoveryCodes[0])
    assert.equal(again.status, 401)
    assert.equal(again.body.code, 'MFA_CODE_INVALID')
    assert.equal((await codeStep((await signIn()).challenge, recoveryCodes[1])).status, 200)
    const { token } = done.body
    assert.equal((await request(app).get('/api/auth/mfa').set(asBearer(token))).body.recoveryCodesRemaining, 6)
  })

  test('a recovery code of another administrator, or one never issued, does not work', async () => {
    const first = await turnOn()
    const second = await turnOn('second-admin@example.com', 'Second Admin')
    assert.equal((await codeStep((await signIn()).challenge, second.recoveryCodes[0])).status, 401)
    assert.equal((await codeStep((await signIn()).challenge, 'AAAAA-AAAAA')).status, 401)
    assert.equal((await codeStep((await signIn()).challenge, first.recoveryCodes[0])).status, 200)
  })

  test('parallel use of one recovery code signs in only once', async () => {
    const { recoveryCodes } = await turnOn()
    const challenges = await Promise.all(Array.from({ length: 4 }, () => signIn()))
    const results = await Promise.all(challenges.map(item => codeStep(item.challenge, recoveryCodes[0])))
    assert.equal(results.filter(item => item.status === 200).length, 1)
  })

  test('making new ones needs the password and a current code, replaces the old ones, and is recorded', async () => {
    const { token, secret, recoveryCodes } = await turnOn()
    await forgetUsedStep()
    assert.equal((await request(app).post('/api/auth/mfa/recovery-codes').set(asBearer(token)).send({ password: 'wrong-password-1', code: codeAt(secret) })).status, 400)
    assert.equal((await request(app).post('/api/auth/mfa/recovery-codes').set(asBearer(token)).send({ password: PASSWORD, code: '000000' })).status, 400)
    const made = await request(app).post('/api/auth/mfa/recovery-codes').set(asBearer(token)).send({ password: PASSWORD, code: codeAt(secret) })
    assert.equal(made.status, 200)
    assert.equal(made.body.recoveryCodes.length, 8)
    assert.ok(made.body.recoveryCodes.every(code => !recoveryCodes.includes(code)))
    assert.equal((await codeStep((await signIn()).challenge, recoveryCodes[0])).status, 401, 'an old code no longer works')
    assert.equal((await codeStep((await signIn()).challenge, made.body.recoveryCodes[0])).status, 200)
    assert.equal((await events({ type: 'recovery_codes_regenerated' })).length, 1)
  })
})

describe('turning it off', () => {
  test('needs the password and a current code (a recovery code also counts), then sign-in is by password alone again', async () => {
    const { token, secret, recoveryCodes } = await turnOn()
    await forgetUsedStep()
    const elsewhere = (await codeStep((await signIn()).challenge, recoveryCodes[0])).body

    assert.equal((await request(app).post('/api/auth/mfa/disable').set(asBearer(token)).send({ password: 'wrong-password-1', code: codeAt(secret) })).status, 400)
    const badCode = await request(app).post('/api/auth/mfa/disable').set(asBearer(token)).send({ password: PASSWORD, code: '000000' })
    assert.equal(badCode.status, 400)
    assert.equal(badCode.body.code, 'MFA_CODE_INVALID')
    assert.equal((await events({ type: 'mfa_failed' })).at(-1).detail, 'while changing settings')
    assert.equal((await request(app).get('/api/auth/mfa').set(asBearer(token))).body.enabled, true, 'a refused request changes nothing')

    const off = await request(app).post('/api/auth/mfa/disable').set(asBearer(token)).send({ password: PASSWORD, code: recoveryCodes[1] })
    assert.equal(off.status, 200)
    assert.equal(off.body.enabled, false)
    assert.equal(await AdminMfa.countDocuments(), 0)
    assert.equal((await events({ type: 'mfa_disabled' })).length, 1)
    assert.equal((await request(app).get('/api/auth/session').set(asBearer(elsewhere.token))).status, 401, 'other devices are signed out')
    assert.equal((await request(app).get('/api/auth/session').set(asBearer(token))).status, 200)

    const plain = await passwordStep()
    assert.equal(plain.body.mfaRequired, undefined)
    assert.equal(plain.body.user.mfaEnabled, false)
  })

  test('is refused when it is not on', async () => {
    await makeAdmin()
    const { token } = await signIn()
    const off = await request(app).post('/api/auth/mfa/disable').set(asBearer(token)).send({ password: PASSWORD, code: '123456' })
    assert.equal(off.status, 400)
    assert.equal(off.body.code, 'MFA_NOT_ENABLED')
    assert.equal((await request(app).post('/api/auth/mfa/recovery-codes').set(asBearer(token)).send({ password: PASSWORD, code: '123456' })).body.code, 'MFA_NOT_ENABLED')
  })

  test('then it can be set up again from scratch with a new secret', async () => {
    const { token, secret, recoveryCodes } = await turnOn()
    await request(app).post('/api/auth/mfa/disable').set(asBearer(token)).send({ password: PASSWORD, code: recoveryCodes[0] })
    const again = await request(app).post('/api/auth/mfa/setup').set(asBearer(token)).send({ password: PASSWORD })
    assert.equal(again.status, 200)
    assert.notEqual(again.body.secret, secret)
  })
})
