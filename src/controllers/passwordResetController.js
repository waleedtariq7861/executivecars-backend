const crypto = require('crypto')
const Admin = require('../models/Admin')
const Member = require('../models/Member')
const Seller = require('../models/Seller')
const PasswordResetToken = require('../models/PasswordResetToken')
const { handleControllerError } = require('../utils/http')
const { isDemoMode } = require('../config/runtime')
const email = require('../utils/email')
const sessions = require('../utils/sessions')
const loginThrottle = require('../utils/loginThrottle')
const { consumeResetRequest } = require('../utils/resetRequests')
const { validatePassword } = require('../utils/passwordPolicy')

const RESET_LINK_LIFETIME_MS = 30 * 60 * 1000

// Customers, administrators and legacy sellers can all reset. When one address exists in more than one
// collection the customer account wins, then the administrator, then the legacy seller.
const ACCOUNT_MODELS = { member: Member, admin: Admin, seller: Seller }
const LOOKUP_ORDER = ['member', 'admin', 'seller']

const normalizeEmail = (value = '') => String(value).trim().toLowerCase()
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')

const findAccountByEmail = async (address) => {
  for (const accountModel of LOOKUP_ORDER) {
    const account = await ACCOUNT_MODELS[accountModel].findOne({ email: address })
    if (account) return { accountModel, account }
  }
  return null
}

// Mail must never change how long the answer takes or whether it succeeds, otherwise the response would
// reveal which addresses have an account. Failures are logged, not reported to the caller.
const sendInBackground = (label, send) => {
  const report = error => console.error(`${label} email delivery failed:`, error?.message || error)
  try { Promise.resolve(send()).catch(report) } catch (error) { report(error) }
}

const requestPasswordReset = async (req, res) => {
  const genericResponse = { message: 'If that email belongs to an account, password reset instructions will be sent.' }
  try {
    const address = normalizeEmail(req.body.email)
    if (!/^\S+@\S+\.\S+$/.test(address)) return res.status(400).json({ message: 'Enter a valid email address', errors: { email: 'Enter a valid email address' } })

    const found = await findAccountByEmail(address)
    let developmentResetUrl
    if (found && await consumeResetRequest(found.accountModel, found.account._id)) {
      const { accountModel, account } = found
      // A new request replaces any link that is still outstanding.
      await PasswordResetToken.deleteMany({ accountModel, accountId: account._id })
      const rawToken = crypto.randomBytes(32).toString('hex')
      await PasswordResetToken.create({
        accountModel, accountId: account._id, tokenHash: sha256(rawToken), expiresAt: new Date(Date.now() + RESET_LINK_LIFETIME_MS),
      })

      const clientUrl = String(process.env.CLIENT_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')
      const resetUrl = `${clientUrl}/reset-password?token=${rawToken}`
      sendInBackground('Password reset', () => email.sendPasswordResetEmail(account.email, resetUrl))
      if (isDemoMode() && process.env.EMAIL_DELIVERY_MODE === 'development') developmentResetUrl = resetUrl
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
    if (typeof password !== 'string') return res.status(400).json({ message: 'Enter a new password', errors: { password: 'Enter a new password' } })

    const resetRecord = await PasswordResetToken.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } })
    if (!resetRecord) return res.status(400).json({ message: 'Invalid or expired reset link' })

    const accountModel = resetRecord.accountModel || 'member'
    const account = await ACCOUNT_MODELS[accountModel]?.findById(resetRecord.accountId)
    if (!account) return res.status(400).json({ message: 'Invalid or expired reset link' })

    // The link stays valid when the new password is rejected, so the person can simply try another one.
    const policy = await validatePassword(password, { email: account.email, name: account.name })
    if (!policy.ok) {
      return res.status(400).json({ message: policy.message, code: policy.code, errors: { password: policy.message } })
    }

    account.password = password
    await account.save({ validateModifiedOnly: true })
    await PasswordResetToken.deleteMany({ accountModel, accountId: account._id })
    // Whoever knew the old password may still hold a session: end them all after a reset.
    if (accountModel !== 'seller') {
      await sessions.revokeAccountSessions({ accountModel, accountId: account._id, reason: 'password_reset', io: req.app.get('io') })
    }
    await loginThrottle.clearEmail(accountModel === 'admin' ? 'admin' : 'member', account.email)
    sendInBackground('Password changed', () => email.sendPasswordChangedEmail(account.email, { name: account.name, reason: 'reset' }))
    res.json({ message: 'Password reset successfully. You can now sign in.' })
  } catch (error) {
    handleControllerError(res, error, 'Could not reset password')
  }
}

module.exports = { requestPasswordReset, resetPassword, RESET_LINK_LIFETIME_MS }
