const LoginAttempt = require('../models/LoginAttempt')
const { increment } = require('./loginThrottle')

// OWASP Forgot Password Cheat Sheet: a person (or an attacker who knows an email address) must not be able to
// flood someone's inbox. Each account may request a few reset links per hour, whatever the source address.
// Beyond the cap the request is answered like any other and simply sends nothing.
const WINDOW_MS = 60 * 60 * 1000
const MAX_REQUESTS = 3

/** Counts one reset request for this account; true while it is still within the hourly allowance. */
const consumeResetRequest = async (accountModel, accountId, now = Date.now()) => {
  const key = `reset:${accountModel}:${accountId}`
  await LoginAttempt.deleteOne({ key, windowStartedAt: { $lte: new Date(now - WINDOW_MS) } })
  const record = await increment(key, now, WINDOW_MS)
  return record.failures <= MAX_REQUESTS
}

module.exports = { consumeResetRequest, WINDOW_MS, MAX_REQUESTS }
