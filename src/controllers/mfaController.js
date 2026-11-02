const Admin = require('../models/Admin')
const AdminMfa = require('../models/AdminMfa')
const MfaChallenge = require('../models/MfaChallenge')
const sessions = require('../utils/sessions')
const { rejectIfThrottled, startSession } = require('../utils/authFlow')
const loginThrottle = require('../utils/loginThrottle')
const { recordAuthEvent } = require('../utils/authEvents')
const { handleControllerError } = require('../utils/http')
const { randomToken, sha256 } = require('../utils/crypto')
const totp = require('../utils/totp')

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000
const MAX_CHALLENGE_ATTEMPTS = 5

const BAD_CODE = { message: 'That code is incorrect or has already been used.', code: 'MFA_CODE_INVALID', errors: { code: 'That code is incorrect or has already been used.' } }
const BAD_CHALLENGE = { message: 'This sign-in has expired. Enter your email and password again.', code: 'MFA_CHALLENGE_INVALID' }

/** Called by the password step of the administrator sign-in: the person now owes the second factor. */
const issueChallenge = async (admin) => {
  const token = randomToken(32)
  await MfaChallenge.deleteMany({ adminId: admin._id })
  await MfaChallenge.create({ adminId: admin._id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + CHALLENGE_LIFETIME_MS) })
  return { token, expiresInSeconds: CHALLENGE_LIFETIME_MS / 1000 }
}

const isMfaEnabled = async adminId => Boolean(await AdminMfa.exists({ adminId, enabledAt: { $exists: true } }))

/**
 * Checks what the person typed as a second factor: a code from the authenticator app or a recovery code.
 * Each is spent with an atomic update, so the same code can never be accepted twice, even by parallel requests.
 * @returns {Promise<{ ok: true, via: 'totp' | 'recovery' } | { ok: false }>}
 */
const verifySecondFactor = async (admin, submitted) => {
  const record = await AdminMfa.findOne({ adminId: admin._id, enabledAt: { $exists: true } }).select('+secretCipher')
  if (!record) return { ok: false }

  const recovery = totp.normalizeRecoveryCode(submitted)
  if (recovery) {
    const spent = await AdminMfa.updateOne(
      { _id: record._id, recoveryCodes: { $elemMatch: { hash: totp.hashRecoveryCode(recovery), usedAt: { $exists: false } } } },
      { $set: { 'recoveryCodes.$.usedAt': new Date() } },
    )
    return spent.modifiedCount === 1 ? { ok: true, via: 'recovery' } : { ok: false }
  }

  const digits = String(submitted ?? '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(digits)) return { ok: false }
  const step = totp.stepForCode(totp.decryptSecret(record.secretCipher, admin._id), digits)
  if (step === null) return { ok: false }
  const spent = await AdminMfa.updateOne({ _id: record._id, lastUsedStep: { $lt: step } }, { $set: { lastUsedStep: step } })
  return spent.modifiedCount === 1 ? { ok: true, via: 'totp' } : { ok: false }
}

// ---- the second step of signing in -------------------------------------------------------------------------

const completeAdminLogin = async (req, res) => {
  try {
    const token = String(req.body.challenge ?? '')
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token) || typeof req.body.code !== 'string' || !req.body.code.trim()) {
      return res.status(400).json({ message: 'Enter the code from your authenticator app.', errors: { code: 'Enter the code from your authenticator app.' } })
    }

    // Every attempt is counted before the code is compared, so parallel guesses cannot exceed the limit.
    const challenge = await MfaChallenge.findOneAndUpdate(
      { tokenHash: sha256(token), attempts: { $lt: MAX_CHALLENGE_ATTEMPTS }, expiresAt: { $gt: new Date() } },
      { $inc: { attempts: 1 } },
      { new: true },
    )
    if (!challenge) return res.status(401).json(BAD_CHALLENGE)
    const admin = await Admin.findById(challenge.adminId)
    if (!admin) return res.status(401).json(BAD_CHALLENGE)

    const who = { ip: req.ip, email: admin.email }
    if (await rejectIfThrottled(res, 'admin', who)) return

    const result = await verifySecondFactor(admin, req.body.code)
    if (!result.ok) {
      await loginThrottle.recordFailure('admin', who)
      await recordAuthEvent('mfa_failed', { req, accountModel: 'admin', accountId: admin._id, email: admin.email })
      return res.status(401).json(BAD_CODE)
    }
    // The challenge is spent exactly once, even if two correct requests arrive together.
    if (!await MfaChallenge.findOneAndDelete({ _id: challenge._id })) return res.status(401).json(BAD_CHALLENGE)

    await loginThrottle.recordSuccess('admin', who)
    if (result.via === 'recovery') {
      const left = await remainingRecoveryCodes(admin._id)
      await recordAuthEvent('recovery_code_used', { req, accountModel: 'admin', accountId: admin._id, email: admin.email, detail: `${left} left` })
    }
    await recordAuthEvent('login_success', { req, accountModel: 'admin', accountId: admin._id, email: admin.email, detail: result.via === 'recovery' ? 'recovery code' : 'authenticator app' })
    return startSession(req, res, {
      account: admin, accountModel: 'admin', role: 'admin',
      user: { id: admin._id, name: admin.name, email: admin.email, role: 'admin', mfaEnabled: true },
      mfaVerified: true,
    })
  } catch (error) {
    return handleControllerError(res, error, 'Could not finish signing in')
  }
}

// ---- managing the second factor (administrators, already signed in) ---------------------------------------------

const remainingRecoveryCodes = async (adminId) => {
  const record = await AdminMfa.findOne({ adminId }).select('+recoveryCodes')
  return (record?.recoveryCodes || []).filter(item => !item.usedAt).length
}

const status = async (req, res) => {
  try {
    const record = await AdminMfa.findOne({ adminId: req.user._id, enabledAt: { $exists: true } })
    res.set('Cache-Control', 'no-store')
    res.json({ enabled: Boolean(record), enabledAt: record?.enabledAt, recoveryCodesRemaining: record ? await remainingRecoveryCodes(req.user._id) : 0 })
  } catch (error) {
    handleControllerError(res, error, 'Could not load the two-step sign-in settings')
  }
}

// Re-confirming the password before a sensitive change protects against a left-open browser.
const passwordConfirmed = async (req, res) => {
  const admin = await Admin.findById(req.user._id)
  if (typeof req.body.password === 'string' && admin && await admin.matchPassword(req.body.password)) return admin
  res.status(400).json({ message: 'Your password is not correct.', errors: { password: 'Your password is not correct.' } })
  return null
}

const setup = async (req, res) => {
  try {
    const admin = await passwordConfirmed(req, res)
    if (!admin) return
    if (await isMfaEnabled(admin._id)) {
      return res.status(409).json({ message: 'Two-step sign-in is already on. Turn it off first to set it up again.', code: 'MFA_ALREADY_ENABLED' })
    }
    const secret = totp.newSecret()
    await AdminMfa.findOneAndUpdate({ adminId: admin._id }, { pendingCipher: totp.encryptSecret(secret, admin._id) }, { upsert: true, setDefaultsOnInsert: true })
    res.set('Cache-Control', 'no-store')
    res.json({ secret, otpauthUrl: totp.otpauthUrl(admin.email, secret) })
  } catch (error) {
    handleControllerError(res, error, 'Could not start the two-step sign-in setup')
  }
}

const enable = async (req, res) => {
  try {
    const record = await AdminMfa.findOne({ adminId: req.user._id, enabledAt: { $exists: false } }).select('+pendingCipher')
    if (!record?.pendingCipher) return res.status(400).json({ message: 'Start the setup first.', code: 'MFA_NOT_STARTED' })

    const digits = String(req.body.code ?? '').replace(/\s+/g, '')
    const step = /^\d{6}$/.test(digits) ? totp.stepForCode(totp.decryptSecret(record.pendingCipher, req.user._id), digits) : null
    if (step === null) return res.status(400).json(BAD_CODE)

    const { codes, hashed } = totp.newRecoveryCodes()
    const turnedOn = await AdminMfa.updateOne(
      { _id: record._id, enabledAt: { $exists: false } },
      { $set: { secretCipher: record.pendingCipher, enabledAt: new Date(), lastUsedStep: step, recoveryCodes: hashed }, $unset: { pendingCipher: 1 } },
    )
    if (turnedOn.modifiedCount !== 1) return res.status(409).json({ message: 'Two-step sign-in is already on.', code: 'MFA_ALREADY_ENABLED' })

    await recordAuthEvent('mfa_enabled', { req, accountModel: 'admin', accountId: req.user._id, email: req.user.email })
    await sessions.revokeAccountSessions({ accountModel: 'admin', accountId: req.user._id, exceptId: req.session._id, reason: 'mfa_enabled', io: req.app.get('io') })
    res.set('Cache-Control', 'no-store')
    // The only time the recovery codes are shown.
    res.json({ enabled: true, recoveryCodes: codes })
  } catch (error) {
    handleControllerError(res, error, 'Could not turn on two-step sign-in')
  }
}

// Shared by "turn off" and "make new recovery codes": the password and a current second-factor code.
const reconfirmed = async (req, res) => {
  const admin = await passwordConfirmed(req, res)
  if (!admin) return null
  if (!await isMfaEnabled(admin._id)) {
    res.status(400).json({ message: 'Two-step sign-in is not on.', code: 'MFA_NOT_ENABLED' })
    return null
  }
  const result = await verifySecondFactor(admin, req.body.code)
  if (!result.ok) {
    await recordAuthEvent('mfa_failed', { req, accountModel: 'admin', accountId: admin._id, email: admin.email, detail: 'while changing settings' })
    res.status(400).json(BAD_CODE)
    return null
  }
  return admin
}

const disable = async (req, res) => {
  try {
    const admin = await reconfirmed(req, res)
    if (!admin) return
    await AdminMfa.deleteOne({ adminId: admin._id })
    await recordAuthEvent('mfa_disabled', { req, accountModel: 'admin', accountId: admin._id, email: admin.email })
    await sessions.revokeAccountSessions({ accountModel: 'admin', accountId: admin._id, exceptId: req.session._id, reason: 'mfa_disabled', io: req.app.get('io') })
    res.json({ enabled: false })
  } catch (error) {
    handleControllerError(res, error, 'Could not turn off two-step sign-in')
  }
}

const regenerateRecoveryCodes = async (req, res) => {
  try {
    const admin = await reconfirmed(req, res)
    if (!admin) return
    const { codes, hashed } = totp.newRecoveryCodes()
    await AdminMfa.updateOne({ adminId: admin._id }, { $set: { recoveryCodes: hashed } })
    await recordAuthEvent('recovery_codes_regenerated', { req, accountModel: 'admin', accountId: admin._id, email: admin.email })
    res.set('Cache-Control', 'no-store')
    res.json({ recoveryCodes: codes })
  } catch (error) {
    handleControllerError(res, error, 'Could not make new recovery codes')
  }
}

module.exports = {
  issueChallenge, isMfaEnabled, verifySecondFactor, completeAdminLogin,
  status, setup, enable, disable, regenerateRecoveryCodes,
  MAX_CHALLENGE_ATTEMPTS, CHALLENGE_LIFETIME_MS,
}
