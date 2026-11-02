const { attachSession } = require('./session')
const sessions = require('./sessions')
const loginThrottle = require('./loginThrottle')

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

// Every sign-in creates a fresh server-side session and hands the browser its opaque token.
const startSession = async (req, res, { account, accountModel, role, user, status = 200, extra = {}, mfaVerified = false }) => {
  const { token, session } = await sessions.createSession({ account, accountModel, role, req, mfaVerified })
  const body = { ...extra, user, csrfToken: attachSession(res, token, session.absoluteExpiresAt.getTime() - Date.now()) }
  return res.status(status).json(body)
}

module.exports = { rejectIfThrottled, startSession, secondsLabel }
