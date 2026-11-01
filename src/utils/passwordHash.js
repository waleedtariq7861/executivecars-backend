const bcrypt = require('bcryptjs')
const argon2 = require('@node-rs/argon2')

// OWASP Password Storage Cheat Sheet: Argon2id, m=19 MiB, t=2, p=1 (the library's default algorithm is Argon2id).
const ARGON2_OPTIONS = Object.freeze({ memoryCost: 19456, timeCost: 2, parallelism: 1 })
const ARGON2_PREFIX = '$argon2id$'

const isArgon2 = (stored) => typeof stored === 'string' && stored.startsWith(ARGON2_PREFIX)
const isBcrypt = (stored) => typeof stored === 'string' && /^\$2[aby]\$/.test(stored)

const hashPassword = (plain) => argon2.hash(String(plain), ARGON2_OPTIONS)

// Accounts created before this change still hold bcrypt hashes; they keep working and are
// upgraded to Argon2id by needsRehash() the next time the owner signs in.
const verifyPassword = async (plain, stored) => {
  if (typeof plain !== 'string' || typeof stored !== 'string' || !plain) return false
  try {
    if (isArgon2(stored)) return await argon2.verify(stored, plain)
    if (isBcrypt(stored)) return await bcrypt.compare(plain, stored)
  } catch {
    return false
  }
  return false
}

const needsRehash = (stored) => !isArgon2(stored) || !stored.includes(`m=${ARGON2_OPTIONS.memoryCost},t=${ARGON2_OPTIONS.timeCost},p=${ARGON2_OPTIONS.parallelism}$`)

// Real hashes of throw-away values, one per scheme, used to pad the work of a sign-in attempt.
// Bcrypt (cost 12) is slow and Argon2id is fast, so an attempt that only did "the real work" would
// reveal whether an email exists and which scheme its hash uses. Every attempt does one verification
// of each scheme instead: the real one where an account exists, a dummy otherwise.
const DUMMY_BCRYPT = '$2a$12$c/etHEVf/.OrLa0OwbW7qeW9X2x69xm05et9DTpV9HovU1owEUPwG'
let dummyArgon2
const getDummyArgon2 = () => (dummyArgon2 ||= hashPassword('executive-cars-timing-equaliser'))

/**
 * Verify `plain` against `stored` (which may be missing) while always spending the cost of one
 * Argon2id and one bcrypt verification, so timing does not depend on the account or its hash type.
 */
const verifyWithEqualCost = async (plain, stored) => {
  const candidate = typeof plain === 'string' ? plain : ''
  const real = typeof stored === 'string' ? stored : ''
  const ok = real ? await verifyPassword(candidate, real) : false
  if (!isArgon2(real)) await verifyPassword(candidate || 'x', await getDummyArgon2())
  if (!isBcrypt(real)) await verifyPassword(candidate || 'x', DUMMY_BCRYPT)
  return ok
}

module.exports = { hashPassword, verifyPassword, verifyWithEqualCost, needsRehash, ARGON2_OPTIONS }
