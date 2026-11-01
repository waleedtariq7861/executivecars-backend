const crypto = require('crypto')
const PasswordResetCode = require('../models/PasswordResetCode')
const { hmac } = require('./crypto')

const CODE_LIFETIME_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5

// Keyed with the account and its current address as well as the code, so a code only works for the address it
// was mailed to, and under a prefix no other code uses.
const digestFor = (accountModel, account, code) =>
  hmac('otp', `password-reset:${accountModel}:${account._id}:${String(account.email).toLowerCase()}:${code}`, 'hex')

/** Creates the account's code, replacing any that is still outstanding (the new one starts with fresh attempts). */
const issueCode = async (accountModel, account, now = Date.now()) => {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
  await PasswordResetCode.findOneAndUpdate(
    { accountModel, accountId: account._id },
    { otpDigest: digestFor(accountModel, account, code), expiresAt: new Date(now + CODE_LIFETIME_MS), attempts: 0 },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
  return code
}

/**
 * Checks a submitted code. Every attempt is counted before it is compared, so parallel guesses cannot exceed
 * the limit. Whatever the reason for a failure (no code, expired, used up, wrong), the caller learns only that
 * it failed. A correct code is returned still unspent: the caller spends it with `consume` once the rest of the
 * request is valid.
 * @returns {Promise<{ ok: true, record: object } | { ok: false }>}
 */
const checkCode = async (accountModel, account, submitted, now = Date.now()) => {
  const record = await PasswordResetCode.findOneAndUpdate(
    { accountModel, accountId: account._id, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true },
  )
  if (!record) return { ok: false }
  if (record.expiresAt.getTime() <= now) {
    await record.deleteOne()
    return { ok: false }
  }
  const expected = Buffer.from(record.otpDigest)
  const supplied = Buffer.from(digestFor(accountModel, account, String(submitted)))
  const correct = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)
  if (!correct) return { ok: false }
  return { ok: true, record }
}

// A correct code with a rejected new password must not cost the person an attempt: they just choose another password.
const refundAttempt = record => PasswordResetCode.updateOne({ _id: record._id }, { $inc: { attempts: -1 } })

/** Spends the code. False when someone else spent it first. */
const consumeCode = async record => Boolean(await PasswordResetCode.findOneAndDelete({ _id: record._id }))

module.exports = { issueCode, checkCode, refundAttempt, consumeCode, CODE_LIFETIME_MS, MAX_ATTEMPTS }
