const email = require('../utils/email')
const { handleControllerError } = require('../utils/http')
const { isDemoMode } = require('../config/runtime')
const { issueCode, cancelCode, checkCode, CODE_LIFETIME_MS, MAX_ATTEMPTS } = require('../utils/emailVerification')

const developmentDelivery = () => isDemoMode() && process.env.EMAIL_DELIVERY_MODE === 'development'

/**
 * Creates a code for the member and mails it. Used by sign-up and by the "send code" endpoint.
 * @returns {Promise<{ sent: true, delivery: 'email' | 'development', devCode?: string, expiresInSeconds: number }
 *   | { sent: false, rateLimited: true, limit: string, retryAfterSeconds: number }
 *   | { sent: false, failed: true }>}
 */
const sendVerificationCode = async (member) => {
  const issued = await issueCode(member)
  if (!issued.ok) return { sent: false, rateLimited: true, limit: issued.limit, retryAfterSeconds: issued.retryAfterSeconds }

  const expiresInSeconds = Math.round(CODE_LIFETIME_MS / 1000)
  // Local demo mode shows the code on screen instead of mailing it, like the booking code does.
  if (developmentDelivery()) return { sent: true, delivery: 'development', devCode: issued.code, expiresInSeconds }

  try {
    await email.sendVerificationCodeEmail(member.email, { name: member.name, code: issued.code })
    return { sent: true, delivery: 'email', expiresInSeconds }
  } catch (error) {
    // The mail never left, so the attempt must not use up the person's allowance of new codes.
    await cancelCode(member)
    console.error('Verification email delivery failed:', error.message)
    return { sent: false, failed: true }
  }
}

const sendCode = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store')
    if (req.user.isEmailVerified()) return res.json({ verified: true })

    const result = await sendVerificationCode(req.user)
    if (result.rateLimited) {
      res.set('Retry-After', String(result.retryAfterSeconds))
      return res.status(429).json({
        message: result.limit === 'daily'
          ? 'You have requested the maximum number of codes for today. Try again later.'
          : 'Please wait a moment before asking for another code.',
        code: result.limit === 'daily' ? 'DAILY_LIMIT' : 'RESEND_TOO_SOON',
        retryAfterSeconds: result.retryAfterSeconds,
      })
    }
    if (result.failed) {
      return res.status(502).json({ message: 'We could not send the code. Please try again in a moment.', code: 'EMAIL_SEND_FAILED' })
    }
    const { sent, ...details } = result
    res.json({ sent, ...details })
  } catch (error) {
    handleControllerError(res, error, 'Could not send the verification code')
  }
}

const REJECTIONS = {
  NO_CODE: 'Ask for a new code first.',
  CODE_EXPIRED: 'This code has expired. Ask for a new one.',
  TOO_MANY_ATTEMPTS: 'Too many incorrect attempts. Ask for a new code.',
  CODE_INCORRECT: 'That code is not correct.',
}

const verifyCode = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store')
    if (req.user.isEmailVerified()) return res.json({ verified: true })

    const submitted = String(req.body.code ?? '').replace(/\s+/g, '')
    if (!/^\d{6}$/.test(submitted)) {
      return res.status(400).json({ message: 'Enter the 6-digit code.', code: 'CODE_FORMAT', errors: { code: 'Enter the 6-digit code.' } })
    }

    const result = await checkCode(req.user, submitted)
    if (!result.ok) {
      const message = REJECTIONS[result.code]
      return res.status(result.status).json({
        message, code: result.code, errors: { code: message },
        ...(result.remainingAttempts !== undefined ? { remainingAttempts: result.remainingAttempts } : {}),
      })
    }
    res.json({ verified: true })
  } catch (error) {
    handleControllerError(res, error, 'Could not verify the code')
  }
}

module.exports = { sendCode, verifyCode, sendVerificationCode, MAX_ATTEMPTS }
