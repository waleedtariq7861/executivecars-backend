const crypto = require('crypto')

const appSecret = () => {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is required')
  return secret
}

// One application secret, many independent keys: a value minted for one job
// (CSRF token, OTP digest, signed document link) can never be replayed as another.
const deriveKey = purpose => Buffer.from(crypto.hkdfSync('sha256', appSecret(), 'executive-cars', `ec:${purpose}`, 32))

const hmac = (purpose, value, encoding = 'base64url') => crypto
  .createHmac('sha256', deriveKey(purpose))
  .update(value)
  .digest(encoding)

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex')

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

module.exports = { deriveKey, hmac, randomToken, safeEqual, sha256 }
