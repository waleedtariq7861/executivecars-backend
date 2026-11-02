const crypto = require('crypto')
const Member = require('../models/Member')
const EmailVerificationCode = require('../models/EmailVerificationCode')
const { hmac } = require('./crypto')

const CODE_LIFETIME_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5
const RESEND_INTERVAL_MS = 60 * 1000
const DAILY_LIMIT = 5
const DAY_MS = 24 * 60 * 60 * 1000

// A customer is verified once they have proved the address (see checkCode and markVerified).
const isEmailVerified = member => Boolean(member?.emailVerifiedAt)

// Keyed with the account and address as well as the code, and under a prefix the booking OTP never uses.
const digestFor = (member, code) => hmac('otp', `account-verification:${member._id}:${String(member.email).toLowerCase()}:${code}`, 'hex')

const secondsUntil = (when, now) => Math.max(1, Math.ceil((when - now) / 1000))

/**
 * Creates (or replaces) the account's code, enforcing the resend allowance.
 * @returns {{ ok: true, code: string, expiresAt: Date } | { ok: false, reason: 'rate_limited', retryAfterSeconds: number, limit: 'interval' | 'daily' }}
 */
const issueCode = async (member, now = Date.now()) => {
  const existing = await EmailVerificationCode.findOne({ accountId: member._id }).lean()
  let dayStartedAt = new Date(now)
  let sentToday = 1
  if (existing) {
    const sinceLast = now - existing.lastSentAt.getTime()
    if (sinceLast < RESEND_INTERVAL_MS) {
      return { ok: false, reason: 'rate_limited', limit: 'interval', retryAfterSeconds: secondsUntil(existing.lastSentAt.getTime() + RESEND_INTERVAL_MS, now) }
    }
    if (now - existing.dayStartedAt.getTime() < DAY_MS) {
      if (existing.sentToday >= DAILY_LIMIT) {
        return { ok: false, reason: 'rate_limited', limit: 'daily', retryAfterSeconds: secondsUntil(existing.dayStartedAt.getTime() + DAY_MS, now) }
      }
      dayStartedAt = existing.dayStartedAt
      sentToday = existing.sentToday + 1
    }
  }
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
  const expiresAt = new Date(now + CODE_LIFETIME_MS)
  await EmailVerificationCode.findOneAndUpdate(
    { accountId: member._id },
    { email: member.email, otpDigest: digestFor(member, code), expiresAt, attempts: 0, lastSentAt: new Date(now), dayStartedAt, sentToday },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
  return { ok: true, code, expiresAt }
}

// Gives back a send that never reached the person, so a mail outage does not use up their daily allowance.
const cancelCode = async (member) => { await EmailVerificationCode.deleteOne({ accountId: member._id }) }

/**
 * Checks a submitted code. Every attempt is counted before it is compared, so parallel guesses cannot
 * exceed the limit. A correct code marks the account verified and is consumed.
 * @returns {{ ok: true } | { ok: false, code: string, status: number, remainingAttempts?: number }}
 */
const checkCode = async (member, submitted, now = Date.now()) => {
  const record = await EmailVerificationCode.findOneAndUpdate(
    { accountId: member._id, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true },
  )
  if (!record) {
    const exists = await EmailVerificationCode.exists({ accountId: member._id })
    return exists
      ? { ok: false, status: 429, code: 'TOO_MANY_ATTEMPTS' }
      : { ok: false, status: 400, code: 'NO_CODE' }
  }
  if (record.expiresAt.getTime() <= now) {
    await record.deleteOne()
    return { ok: false, status: 400, code: 'CODE_EXPIRED' }
  }
  const expected = Buffer.from(record.otpDigest)
  const supplied = Buffer.from(digestFor(member, String(submitted)))
  const correct = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)
  // The code only counts for the address it was sent to.
  if (!correct || record.email !== String(member.email).toLowerCase()) {
    return { ok: false, status: 400, code: 'CODE_INCORRECT', remainingAttempts: Math.max(0, MAX_ATTEMPTS - record.attempts) }
  }
  await Member.updateOne({ _id: member._id, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date(now) } })
  await record.deleteOne()
  return { ok: true }
}

// An address that was just proven some other way (the booking code) needs no second proof.
const markVerified = (memberId) => Member.updateOne({ _id: memberId, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date() } })

module.exports = {
  isEmailVerified, issueCode, cancelCode, checkCode, markVerified,
  CODE_LIFETIME_MS, MAX_ATTEMPTS, RESEND_INTERVAL_MS, DAILY_LIMIT, DAY_MS,
}
