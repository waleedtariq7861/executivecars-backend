const argon2 = require('@node-rs/argon2')

// OWASP Password Storage Cheat Sheet: Argon2id, m=19 MiB, t=2, p=1 (the library's default algorithm is Argon2id).
const ARGON2_OPTIONS = Object.freeze({ memoryCost: 19456, timeCost: 2, parallelism: 1 })

const hashPassword = (plain) => argon2.hash(String(plain), ARGON2_OPTIONS)

const verifyPassword = async (plain, stored) => {
  if (typeof plain !== 'string' || typeof stored !== 'string' || !plain || !stored) return false
  try {
    return await argon2.verify(stored, plain)
  } catch {
    return false
  }
}

// A real Argon2id hash of a throw-away value. A sign-in attempt for an address with no account verifies against
// it, so the response takes as long as one for a real account and does not reveal which addresses are registered.
let dummyHash
const getDummyHash = () => (dummyHash ||= hashPassword('executive-cars-timing-equaliser'))

/**
 * Verify `plain` against `stored` (which may be missing), always spending the cost of one Argon2id verification.
 */
const verifyWithEqualCost = async (plain, stored) => {
  const candidate = typeof plain === 'string' ? plain : ''
  if (typeof stored === 'string' && stored) return verifyPassword(candidate, stored)
  await verifyPassword(candidate || 'x', await getDummyHash())
  return false
}

module.exports = { hashPassword, verifyPassword, verifyWithEqualCost, ARGON2_OPTIONS }
