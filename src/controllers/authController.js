const Admin  = require('../models/Admin')
const Member = require('../models/Member')
const Seller = require('../models/Seller')
const { handleControllerError } = require('../utils/http')
const email = require('../utils/email')
const { attachSession, clearSession, csrfTokenForSession, sessionTokenFromRequest } = require('../utils/session')
const sessions = require('../utils/sessions')
const loginThrottle = require('../utils/loginThrottle')
const { hashPassword, verifyWithEqualCost } = require('../utils/passwordHash')
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

const secondsLabel = (seconds) => (seconds >= 120 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} second${seconds === 1 ? '' : 's'}`)

// 429 with Retry-After while a throttle delay is running. Returns true when it answered.
const rejectIfThrottled = async (res, kind, who) => {
  const wait = await loginThrottle.check(kind, who)
  if (!wait) return false
  res.set('Retry-After', String(wait))
  res.status(429).json({
    message: `Too many failed sign-in attempts. Try again in ${secondsLabel(wait)}.`,
    code: 'LOGIN_THROTTLED',
    retryAfterSeconds: wait,
  })
  return true
}

const passwordProblem = (res, result) => res.status(400).json({
  message: result.message, code: result.code, errors: { password: result.message },
})

// An older bcrypt hash is replaced by Argon2id the first time its owner signs in. Written directly (not
// through save()) so validation of unrelated fields cannot block a sign-in, and it does not count as a
// password change. A failure here must never fail the sign-in itself.
const upgradeHashIfNeeded = async (Model, account, password) => {
  if (!account.passwordNeedsRehash()) return
  try {
    await Model.updateOne({ _id: account._id }, { $set: { password: await hashPassword(password) } })
  } catch (error) {
    console.error('Password hash upgrade failed:', error.message)
  }
}

// Every sign-in creates a fresh server-side session and hands the browser its opaque token.
const startSession = async (req, res, { account, accountModel, role, user, status = 200, extra = {} }) => {
  const { token, session } = await sessions.createSession({ account, accountModel, role, req })
  const body = { ...extra, user, csrfToken: attachSession(res, token, session.absoluteExpiresAt.getTime() - Date.now()) }
  if (process.env.EXPOSE_AUTH_TOKEN_FOR_TESTS === 'true' && process.env.NODE_ENV === 'test') body.token = token
  return res.status(status).json(body)
}

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
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    await loginThrottle.recordSuccess('admin', who)
    await upgradeHashIfNeeded(Admin, admin, password)
    await startSession(req, res, {
      account: admin, accountModel: 'admin', role: 'admin',
      user: { id: admin._id, name: admin.name, email: admin.email, role: 'admin' },
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

    const legacySeller = await Seller.findOne({ email })
    if (legacySeller) {
      return res.status(409).json({ message: 'An account already exists for this email. Please sign in instead.' })
    }

    const account = await Member.create({ name, email, phone, password, role: 'user' })
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

    let account = await Member.findOne({ email })
    const legacySeller = await Seller.findOne({ email })
    // Every attempt does the same hashing work whether or not the account exists (see passwordHash.js).
    let valid = await verifyWithEqualCost(password, account?.password)
    let sellerValid = false
    if (!valid) sellerValid = await verifyWithEqualCost(password, legacySeller?.password)

    // Transparently migrate a legacy seller the first time they use unified sign-in.
    if (!valid && legacySeller && sellerValid) {
      if (!account) {
        account = await Member.create({
          name: legacySeller.name,
          email: legacySeller.email,
          phone: legacySeller.phone,
          cnic: legacySeller.cnic,
          address: legacySeller.address,
          password,
          role: 'user',
          // A legacy seller's address was already proven by the booking code.
          emailVerifiedAt: new Date(),
          sellerApproved: true,
          sellerBookingId: legacySeller.bookingId,
        })
      } else {
        account.password = password
        account.sellerApproved = true
        account.sellerBookingId = account.sellerBookingId || legacySeller.bookingId
        await account.save()
      }
      valid = true
    }

    if (!account || !valid) {
      await loginThrottle.recordFailure('member', who)
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    await loginThrottle.recordSuccess('member', who)
    await upgradeHashIfNeeded(Member, account, password)

    if (legacySeller && !account.sellerApproved) {
      account.sellerApproved = true
      account.sellerBookingId = account.sellerBookingId || legacySeller.bookingId
      await account.save()
    }

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

    const Model = req.accountRole === 'admin' ? Admin : req.accountModel === 'seller' ? Seller : Member
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
    try {
      email.sendPasswordChangedEmail(fresh.email, { name: fresh.name, reason: 'change' })?.catch?.(error => console.error('Password changed email delivery failed:', error.message))
    } catch (error) {
      console.error('Password changed email delivery failed:', error.message)
    }
    res.json({ message: 'Password updated successfully' })
  } catch (err) {
    handleControllerError(res, err, 'Password update failed')
  }
}

const session = async (req, res) => {
  const token = sessionTokenFromRequest(req)
  const user = req.accountRole === 'admin'
    ? { id: req.user._id, name: req.user.name, email: req.user.email, role: 'admin' }
    : req.accountModel === 'seller'
      ? {
          id: req.user._id, name: req.user.name, email: req.user.email, phone: req.user.phone,
          role: 'user', sellerApproved: true,
          subscriptionStatus: 'inactive', subscriptionExpiry: null,
          capabilities: { buy: true, sell: true, auction: false },
        }
      : accountPayload(req.user)
  res.set('Cache-Control', 'no-store')
  res.json({ user, csrfToken: csrfTokenForSession(token) })
}

// Works with any cookie, even a stale one: the session (if it still exists) is revoked on the server
// and the cookie is always expired, so signing out never depends on the session being valid.
const logout = async (req, res) => {
  try {
    const token = sessionTokenFromRequest(req)
    if (token) {
      const { session } = await sessions.findSession(token)
      if (session) await sessions.revokeSession(session, 'logout', req.app.get('io'))
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
  memberRegister: accountRegister,
  memberLogin: accountLogin,
  sellerLogin: accountLogin,
  changePassword,
  session,
  logout,
}
