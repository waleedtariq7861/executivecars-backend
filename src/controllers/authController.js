const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const Admin  = require('../models/Admin')
const Member = require('../models/Member')
const Seller = require('../models/Seller')
const PasswordResetToken = require('../models/PasswordResetToken')
const { handleControllerError } = require('../utils/http')
const { isDemoMode } = require('../config/runtime')
const { sendPasswordResetEmail } = require('../utils/email')
const { attachSession, clearSession, csrfTokenForSession, sessionTokenFromRequest } = require('../utils/session')
const {
  normalizePersonName,
  normalizePhone,
  validateProfileInput,
} = require('../utils/inputValidation')

const normalizeEmail = (email = '') => String(email).trim().toLowerCase()

const signToken = (id, role) =>
  jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' })

const sendAuthenticated = (res, token, user, status = 200) => {
  const body = { user, csrfToken: attachSession(res, token) }
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
    sellerApproved: Boolean(account.sellerApproved),
    subscriptionStatus: auctionActive ? 'active' : (account.subscriptionStatus === 'active' ? 'expired' : account.subscriptionStatus),
    subscriptionExpiry: account.subscriptionExpiry,
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
    if (!/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string' || !password) {
      return res.status(400).json({ message: 'A valid email and password are required' })
    }

    const admin = await Admin.findOne({ email })
    if (!admin || !(await admin.matchPassword(password))) {
      return res.status(401).json({ message: 'Invalid credentials' })
    }

    const token = signToken(admin._id, 'admin')
    sendAuthenticated(res, token, { id: admin._id, name: admin.name, email: admin.email, role: 'admin' })
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
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' })

    const exists = await Member.findOne({ email })
    if (exists) return res.status(409).json({ message: 'Email already registered' })

    const legacySeller = await Seller.findOne({ email })
    if (legacySeller) {
      return res.status(409).json({ message: 'An account already exists for this email. Sign in with your seller credentials.' })
    }

    const account = await Member.create({ name, email, phone, password, role: 'user' })
    const token = signToken(account._id, 'user')
    sendAuthenticated(res, token, accountPayload(account), 201)
  } catch (err) {
    handleControllerError(res, err, 'Registration failed')
  }
}

const accountLogin = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email)
    const { password } = req.body
    if (!/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string' || !password) {
      return res.status(400).json({ message: 'A valid email and password are required' })
    }

    let account = await Member.findOne({ email })
    const legacySeller = await Seller.findOne({ email })
    let valid = account ? await account.matchPassword(password) : false

    // Transparently migrate a legacy seller the first time they use unified sign-in.
    if (!valid && legacySeller && await legacySeller.matchPassword(password)) {
      if (!account) {
        account = await Member.create({
          name: legacySeller.name,
          email: legacySeller.email,
          phone: legacySeller.phone,
          cnic: legacySeller.cnic,
          address: legacySeller.address,
          password,
          role: 'user',
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

    if (!account || !valid) return res.status(401).json({ message: 'Invalid credentials' })

    if (legacySeller && !account.sellerApproved) {
      account.sellerApproved = true
      account.sellerBookingId = account.sellerBookingId || legacySeller.bookingId
      await account.save()
    }

    await expireMembershipIfNeeded(account)

    const token = signToken(account._id, 'user')
    sendAuthenticated(res, token, accountPayload(account))
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
    if (newPassword.length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters' })

    const Model = req.accountRole === 'admin' ? Admin : req.accountModel === 'seller' ? Seller : Member
    const fresh = await Model.findById(req.user._id)
    if (!fresh || !(await fresh.matchPassword(current))) return res.status(401).json({ message: 'Current password is incorrect' })

    fresh.password = newPassword
    await fresh.save()
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

const logout = (req, res) => {
  clearSession(res)
  res.set('Cache-Control', 'no-store')
  res.json({ message: 'Signed out successfully' })
}

const requestPasswordReset = async (req, res) => {
  const genericResponse = { message: 'If that email belongs to an account, password reset instructions will be sent.' }
  try {
    const email = normalizeEmail(req.body.email)
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address' })

    const account = await Member.findOne({ email })
    if (!account) return res.json(genericResponse)

    await PasswordResetToken.deleteMany({ accountId: account._id })
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    await PasswordResetToken.create({ accountId: account._id, tokenHash, expiresAt: new Date(Date.now() + 30 * 60 * 1000) })

    const clientUrl = String(process.env.CLIENT_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')
    const resetUrl = `${clientUrl}/reset-password?token=${rawToken}`
    let developmentResetUrl
    try {
      await sendPasswordResetEmail(account.email, resetUrl)
      if (isDemoMode() && process.env.EMAIL_DELIVERY_MODE === 'development') developmentResetUrl = resetUrl
    } catch (emailError) {
      if (isDemoMode() && process.env.EMAIL_DELIVERY_MODE === 'development') developmentResetUrl = resetUrl
      else console.error('Password reset email delivery failed:', emailError.message)
    }

    res.json({ ...genericResponse, ...(developmentResetUrl ? { developmentResetUrl } : {}) })
  } catch (error) {
    handleControllerError(res, error, 'Could not process password reset request')
  }
}

const resetPassword = async (req, res) => {
  try {
    const token = String(req.body.token || '')
    const password = req.body.password
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ message: 'Invalid or expired reset link' })
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' })

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const resetRecord = await PasswordResetToken.findOne({ tokenHash, expiresAt: { $gt: new Date() } })
    if (!resetRecord) return res.status(400).json({ message: 'Invalid or expired reset link' })

    const account = await Member.findById(resetRecord.accountId)
    if (!account) return res.status(400).json({ message: 'Invalid or expired reset link' })
    account.password = password
    await account.save()
    await PasswordResetToken.deleteMany({ accountId: account._id })
    res.json({ message: 'Password reset successfully. You can now sign in.' })
  } catch (error) {
    handleControllerError(res, error, 'Could not reset password')
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
  requestPasswordReset,
  resetPassword,
  session,
  logout,
}
