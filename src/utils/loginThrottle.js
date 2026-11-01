const LoginAttempt = require('../models/LoginAttempt')
const { sha256 } = require('./crypto')

// OWASP Authentication Cheat Sheet: throttle failures with a growing delay instead of a hard lockout,
// so an attacker cannot lock a real user out of their own account for good.
// State lives in MongoDB (not process memory), so it survives restarts and is shared by every instance.
const WINDOW_MS = 15 * 60 * 1000
const MAX_DELAY_MS = 15 * 60 * 1000

// Failures tolerated inside the window before the delay starts, per bucket.
const LIMITS = {
  member: { pair: 5, email: 20, ip: 30 },
  admin: { pair: 3, email: 10, ip: 15 },
}

const identity = ({ ip, email }) => ({
  ip: String(ip || 'unknown'),
  email: String(email || '').trim().toLowerCase(),
})

const buckets = (kind, who) => {
  const limits = LIMITS[kind] || LIMITS.member
  const { ip, email } = identity(who)
  return [
    { key: `pair:${kind}:${sha256(`${ip}|${email}`)}`, free: limits.pair },
    { key: `email:${kind}:${sha256(email)}`, free: limits.email },
    { key: `ip:${kind}:${sha256(ip)}`, free: limits.ip },
  ]
}

// 1 s after the first failure over the limit, doubling each time, capped at 15 minutes.
const delayFor = (failures, free) => Math.min(MAX_DELAY_MS, 1000 * 2 ** Math.max(0, failures - free - 1))

/** Seconds the caller must wait before another attempt, or 0 when attempts are allowed. */
const check = async (kind, who, now = Date.now()) => {
  const records = await LoginAttempt.find({ key: { $in: buckets(kind, who).map(bucket => bucket.key) } }).lean()
  const waitMs = records.reduce((longest, record) => Math.max(longest, record.blockedUntil ? record.blockedUntil.getTime() - now : 0), 0)
  return waitMs > 0 ? Math.ceil(waitMs / 1000) : 0
}

// Two simultaneous first failures can both try to insert the bucket; the loser just retries as an update.
const increment = async (key, now, windowMs = WINDOW_MS) => {
  const update = { $inc: { failures: 1 }, $setOnInsert: { windowStartedAt: new Date(now) }, $set: { expireAt: new Date(now + windowMs) } }
  try {
    return await LoginAttempt.findOneAndUpdate({ key }, update, { upsert: true, new: true })
  } catch (error) {
    if (error?.code !== 11000) throw error
    return LoginAttempt.findOneAndUpdate({ key }, update, { upsert: true, new: true })
  }
}

const recordFailure = async (kind, who, now = Date.now()) => {
  for (const { key, free } of buckets(kind, who)) {
    // Start a new window when the previous one ended and no delay is still running.
    await LoginAttempt.deleteOne({ key, windowStartedAt: { $lte: new Date(now - WINDOW_MS) }, $or: [{ blockedUntil: { $exists: false } }, { blockedUntil: { $lte: new Date(now) } }] })
    const record = await increment(key, now)
    const delay = record.failures > free ? delayFor(record.failures, free) : 0
    if (delay > 0) {
      await LoginAttempt.updateOne({ key }, { $set: { blockedUntil: new Date(now + delay), expireAt: new Date(now + Math.max(delay, WINDOW_MS)) } })
    }
  }
}

// A correct password clears the buckets tied to this person; the per-IP bucket keeps counting
// so one valid login cannot be used to wash away a guessing run from the same address.
const recordSuccess = async (kind, who) => {
  const [pair, email] = buckets(kind, who)
  await LoginAttempt.deleteMany({ key: { $in: [pair.key, email.key] } })
}

// After a password reset the person must not be stuck behind a delay earned by someone else's guesses.
const clearEmail = async (kind, email) => {
  const [, byEmail] = buckets(kind, { ip: '', email })
  await LoginAttempt.deleteOne({ key: byEmail.key })
}

module.exports = { check, recordFailure, recordSuccess, clearEmail, increment, delayFor, WINDOW_MS, LIMITS }
