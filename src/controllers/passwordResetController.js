const Admin = require('../models/Admin')
const Member = require('../models/Member')
const { handleControllerError } = require('../utils/http')
const { isDemoMode } = require('../config/runtime')
const email = require('../utils/email')
const { recordAuthEvent } = require('../utils/authEvents')
const { sendInBackground } = require('../utils/background')
const sessions = require('../utils/sessions')
const loginThrottle = require('../utils/loginThrottle')
const { consumeResetRequest } = require('../utils/resetRequests')
const { validatePassword } = require('../utils/passwordPolicy')
const resetCode = require('../utils/passwordResetCode')

// Customers and administrators can reset. When one address exists in both collections the customer account wins.
const ACCOUNT_MODELS = { member: Member, admin: Admin }
const LOOKUP_ORDER = ['member', 'admin']

const normalizeEmail = (value = '') => String(value).trim().toLowerCase()

const findAccountByEmail = async (address) => {
  for (const accountModel of LOOKUP_ORDER) {
    const account = await ACCOUNT_MODELS[accountModel].findOne({ email: address })
    if (account) return { accountModel, account }
  }
  return null
}

// One answer for every way a code can fail (unknown address, no code, expired, used up, wrong), so the response
// never reveals which addresses have an account.
const INVALID_CODE = { message: 'That code is incorrect or has expired. Request a new one.', code: 'RESET_CODE_INVALID' }

const requestPasswordReset = async (req, res) => {
  const genericResponse = { message: 'If that email belongs to an account, a password reset code will be sent to it.' }
  try {
    const address = normalizeEmail(req.body.email)
    if (!/^\S+@\S+\.\S+$/.test(address)) return res.status(400).json({ message: 'Enter a valid email address', errors: { email: 'Enter a valid email address' } })

    const found = await findAccountByEmail(address)
    let developmentCode
    if (found && await consumeResetRequest(found.accountModel, found.account._id)) {
      const { accountModel, account } = found
      const code = await resetCode.issueCode(accountModel, account)
      await recordAuthEvent('reset_requested', { req, accountModel, accountId: account._id, email: account.email })
      sendInBackground(
        'Password reset',
        () => email.sendPasswordResetCodeEmail(account.email, { name: account.name, code }),
        () => recordAuthEvent('mail_failed', { accountModel, accountId: account._id, email: account.email, detail: 'password reset code' }),
      )
      if (isDemoMode() && process.env.EMAIL_DELIVERY_MODE === 'development') developmentCode = code
    }

    res.json({ ...genericResponse, ...(developmentCode ? { developmentCode } : {}) })
  } catch (error) {
    handleControllerError(res, error, 'Could not process password reset request')
  }
}

const resetPassword = async (req, res) => {
  try {
    const address = normalizeEmail(req.body.email)
    const submittedCode = String(req.body.code ?? '').replace(/\s+/g, '')
    const password = req.body.password
    if (!/^\S+@\S+\.\S+$/.test(address)) return res.status(400).json({ message: 'Enter a valid email address', errors: { email: 'Enter a valid email address' } })
    if (!/^\d{6}$/.test(submittedCode)) return res.status(400).json({ message: 'Enter the 6-digit code', errors: { code: 'Enter the 6-digit code' } })
    if (typeof password !== 'string') return res.status(400).json({ message: 'Enter a new password', errors: { password: 'Enter a new password' } })

    const found = await findAccountByEmail(address)
    if (!found) return res.status(400).json(INVALID_CODE)
    const { accountModel, account } = found

    const checked = await resetCode.checkCode(accountModel, account, submittedCode)
    if (!checked.ok) return res.status(400).json(INVALID_CODE)

    // Only someone who holds the right code learns whether the password is acceptable, and a rejected password
    // gives the attempt back so the person can simply try another one.
    const policy = await validatePassword(password, { email: account.email, name: account.name })
    if (!policy.ok) {
      await resetCode.refundAttempt(checked.record)
      return res.status(400).json({ message: policy.message, code: policy.code, errors: { password: policy.message } })
    }

    if (!await resetCode.consumeCode(checked.record)) return res.status(400).json(INVALID_CODE)

    account.password = password
    await account.save({ validateModifiedOnly: true })
    // Whoever knew the old password may still hold a session: end them all after a reset.
    await sessions.revokeAccountSessions({ accountModel, accountId: account._id, reason: 'password_reset', io: req.app.get('io') })
    await loginThrottle.clearEmail(accountModel, account.email)
    await recordAuthEvent('reset_completed', { req, accountModel, accountId: account._id, email: account.email })
    sendInBackground(
      'Password changed',
      () => email.sendPasswordChangedEmail(account.email, { name: account.name, reason: 'reset' }),
      () => recordAuthEvent('mail_failed', { accountModel, accountId: account._id, email: account.email, detail: 'password changed notice' }),
    )
    res.json({ message: 'Password reset successfully. You can now sign in.' })
  } catch (error) {
    handleControllerError(res, error, 'Could not reset password')
  }
}

module.exports = { requestPasswordReset, resetPassword }
