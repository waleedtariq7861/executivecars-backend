const Admin  = require('../models/Admin')
const Member = require('../models/Member')
const { handleControllerError } = require('../utils/http')
const email = require('../utils/email')
const { sendInBackground } = require('../utils/background')
const { recordAuthEvent } = require('../utils/authEvents')
const { clearSession, csrfTokenForSession, sessionTokenFromRequest } = require('../utils/session')
const { rejectIfThrottled, startSession } = require('../utils/authFlow')
const mfa = require('./mfaController')
const sessions = require('../utils/sessions')
const loginThrottle = require('../utils/loginThrottle')
const { verifyWithEqualCost } = require('../utils/passwordHash')
const { validatePassword } = require('../utils/passwordPolicy')
const { sendVerificationCode } = require('./emailVerificationController')
const {
  normalizePersonName,
  normalizePhone,
  validateProfileInput,
} = require('../utils/inputValidation')

const normalizeEmail = (email = '') => String(email).trim().toLowerCase()

const MAX_LOGIN_PASSWORD_LENGTH = 1024

const loginInputIsValid = (email, password) => /^\S+@\S+\.\S+$/.test(email)
  && typeof password === 'string' && password.length > 0 && password.length <= MAX_LOGIN_PASSWORD_LENGTH

const passwordProblem = (res, result) => res.status(400).json({
  message: result.message, code: result.code, errors: { password: result.message },
})

const accountPayload = (account) => {
  const auctionActive = account.hasActiveSubscription()
  return {
    id: account._id,
    name: account.name,
    email: account.email,
    phone: account.phone,
    role: 'user',
    emailVerified: account.isEmailVerified(),
    sellerApproved: Boolean(account.sellerApproved),
    subscriptionStatus: auctionActive ? 'active' : (account.subscriptionStatus === 'active' ? 'expired' : account.subscriptionStatus),
    subscriptionExpiry: account.subscriptionExpiry,
    subscriptionPlan: account.subscriptionPlan,
    subscriptionStartedAt: account.subscriptionStartedAt,
    membershipSource: account.membershipSource,
    capabilities: {
      buy: true,
      sell: true,
      auction: auctionActive,
    },
  }
}

const expireMembershipIfNeeded = async (account) => {
  if (account.subscriptionStatus === 'active' && !account.hasActiveSubscription()) {
    account.subscriptionStatus = 'expired'
    await account.save()
  }
}

const adminLogin = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email)
    const { password } = req.body
    if (!loginInputIsValid(email, password)) {
      return res.status(400).json({ message: 'A valid email and password are required' })
    }

    const who = { ip: req.ip, email }
    if (await rejectIfThrottled(res, 'admin', who)) return

    const admin = await Admin.findOne({ email })
    const valid = await verifyWithEqualCost(password, admin?.password)
    if (!admin || !valid) {
      await loginThrottle.recordFailure('admin', who)
      // Only attempts on a real account are logged: a flood of guesses at made-up addresses must not fill the audit trail.
      if (admin) await recordAuthEvent('login_failure', { req, accountModel: 'admin', accountId: admin._id, email })
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    // With two-step sign-in on, the password alone is not a sign-in: no session yet, and the throttle is NOT
    // reset, so a stolen password cannot be used to guess second-factor codes without limit.
    if (await mfa.isMfaEnabled(admin._id)) {
      const challenge = await mfa.issueChallenge(admin)
      res.set('Cache-Control', 'no-store')
      return res.json({ mfaRequired: true, challenge: challenge.token, expiresInSeconds: challenge.expiresInSeconds })
    }

    await loginThrottle.recordSuccess('admin', who)
    await recordAuthEvent('login_success', { req, accountModel: 'admin', accountId: admin._id, email })
    await startSession(req, res, {
      account: admin, accountModel: 'admin', role: 'admin',
      user: { id: admin._id, name: admin.name, email: admin.email, role: 'admin', mfaEnabled: false },
    })
  } catch (err) {
    handleControllerError(res, err, 'Admin sign in failed')
  }
}

// One customer account for buying, selling, and optional auction membership.
const accountRegister = async (req, res) => {
  try {
    const name = normalizePersonName(req.body.name)
    const email = normalizeEmail(req.body.email)
    const phone = normalizePhone(req.body.phone)
    const { password } = req.body
    const { errors } = validateProfileInput({ name, phone }, { requireName: true, requirePhone: true })
    if (Object.keys(errors).length || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string') {
      return res.status(400).json({
        message: 'Please enter a valid name, email, phone, and password.',
        errors,
      })
    }
    const policy = await validatePassword(password, { email, name })
    if (!policy.ok) return passwordProblem(res, policy)

    const exists = await Member.findOne({ email })
    if (exists) return res.status(409).json({ message: 'Email already registered' })

    const account = await Member.create({ name, email, phone, password, role: 'user' })
    await recordAuthEvent('registered', { req, accountModel: 'member', accountId: account._id, email })
    // The sign-up response says whether the code went out, so the screen can offer a resend instead of failing silently.
    const verification = await sendVerificationCode(account)
    await startSession(req, res, { account, accountModel: 'member', role: 'user', user: accountPayload(account), status: 201, extra: { verification } })
  } catch (err) {
    handleControllerError(res, err, 'Registration failed')
  }
}

const accountLogin = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email)
    const { password } = req.body
    if (!loginInputIsValid(email, password)) {
      return res.status(400).json({ message: 'A valid email and password are required' })
    }

    const who = { ip: req.ip, email }
    if (await rejectIfThrottled(res, 'member', who)) return

    const account = await Member.findOne({ email })
    // Every attempt does the same hashing work whether or not the account exists (see passwordHash.js).
    const valid = await verifyWithEqualCost(password, account?.password)
    if (!account || !valid) {
      await loginThrottle.recordFailure('member', who)
      if (account) await recordAuthEvent('login_failure', { req, accountModel: 'member', accountId: account._id, email })
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    await loginThrottle.recordSuccess('member', who)
    await recordAuthEvent('login_success', { req, accountModel: 'member', accountId: account._id, email })

    await expireMembershipIfNeeded(account)

    await startSession(req, res, { account, accountModel: 'member', role: 'user', user: accountPayload(account) })
  } catch (err) {
    handleControllerError(res, err, 'Sign in failed')
  }
}

const changePassword = async (req, res) => {
  try {
    const { current, newPassword } = req.body
    if (typeof current !== 'string' || typeof newPassword !== 'string' || !current || !newPassword) {
      return res.status(400).json({ message: 'Both password fields are required' })
    }

    const Model = req.accountRole === 'admin' ? Admin : Member
    const fresh = await Model.findById(req.user._id)
    if (!fresh) return res.status(401).json({ message: 'Account not found' })
    // 400, not 401: the session is valid and clients treat 401 as "signed out".
    if (!(await fresh.matchPassword(current))) {
      return res.status(400).json({ message: 'Current password is incorrect', errors: { current: 'Current password is incorrect' } })
    }
    if (newPassword === current) {
      const message = 'Choose a password different from your current one.'
      return res.status(400).json({ message, code: 'PASSWORD_UNCHANGED', errors: { password: message } })
    }
    const policy = await validatePassword(newPassword, { email: fresh.email, name: fresh.name })
    if (!policy.ok) return passwordProblem(res, policy)

    fresh.password = newPassword
    await fresh.save({ validateModifiedOnly: true })
    // Anyone holding an older session (another device, a stolen cookie) is signed out; this one stays.
    await sessions.revokeAccountSessions({
      accountModel: req.accountModel, accountId: fresh._id, exceptId: req.session?._id, reason: 'password_changed', io: req.app.get('io'),
    })
    await recordAuthEvent('password_changed', { req, accountModel: req.accountModel, accountId: fresh._id, email: fresh.email, detail: 'from account settings' })
    sendInBackground(
      'Password changed',
      () => email.sendPasswordChangedEmail(fresh.email, { name: fresh.name, reason: 'change' }),
      () => recordAuthEvent('mail_failed', { accountModel: req.accountModel, accountId: fresh._id, email: fresh.email, detail: 'password changed notice' }),
    )
    res.json({ message: 'Password updated successfully' })
  } catch (err) {
    handleControllerError(res, err, 'Password update failed')
  }
}

const session = async (req, res) => {
  try {
    const token = sessionTokenFromRequest(req)
    const user = req.accountRole === 'admin'
      ? { id: req.user._id, name: req.user.name, email: req.user.email, role: 'admin', mfaEnabled: await mfa.isMfaEnabled(req.user._id) }
      : accountPayload(req.user)
    res.set('Cache-Control', 'no-store')
    res.json({ user, csrfToken: csrfTokenForSession(token) })
  } catch (err) {
    handleControllerError(res, err, 'Could not load your session')
  }
}

// Works with any cookie, even a stale one: the session (if it still exists) is revoked on the server
// and the cookie is always expired, so signing out never depends on the session being valid.
const logout = async (req, res) => {
  try {
    const token = sessionTokenFromRequest(req)
    if (token) {
      const { session } = await sessions.findSession(token)
      if (session) {
        const wasLive = !session.revokedAt
        await sessions.revokeSession(session, 'logout', req.app.get('io'))
        if (wasLive) await recordAuthEvent('logout', { req, accountModel: session.accountModel, accountId: session.accountId })
      }
    }
    clearSession(res)
    res.set('Cache-Control', 'no-store')
    res.json({ message: 'Signed out successfully' })
  } catch (err) {
    handleControllerError(res, err, 'Could not sign out')
  }
}

module.exports = {
  adminLogin,
  accountRegister,
  accountLogin,
  changePassword,
  session,
  logout,
}
