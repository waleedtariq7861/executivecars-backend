const crypto = require('crypto')
const { authenticator } = require('otplib')
const { deriveKey, hmac } = require('./crypto')

const STEP_SECONDS = 30
const ISSUER = 'Executive Cars'
// One 30-second step either side tolerates a clock that is a little off, as authenticator apps expect.
const totp = authenticator.clone({ step: STEP_SECONDS, digits: 6, window: 1 })

// 160-bit secret, the size RFC 4226 recommends (otplib's default is only 80 bits).
const newSecret = () => totp.generateSecret(20)

const otpauthUrl = (email, secret) => totp.keyuri(email, ISSUER, secret)

/** The 30-second step a code belongs to (the current step or one either side), or null when it is not valid. */
const stepForCode = (secret, code, now = Date.now()) => {
  const delta = totp.checkDelta(String(code), secret)
  return delta === null ? null : Math.floor(now / 1000 / STEP_SECONDS) + delta
}

// Secrets are encrypted with AES-256-GCM under a key derived from the application secret. The account id is
// authenticated data, so a ciphertext copied onto another administrator's record does not decrypt.
const encryptSecret = (plain, accountId) => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('totp'), iv)
  cipher.setAAD(Buffer.from(String(accountId)))
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.')
}

const decryptSecret = (packed, accountId) => {
  const [iv, tag, encrypted] = String(packed).split('.').map(part => Buffer.from(part, 'base64url'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('totp'), iv)
  decipher.setAAD(Buffer.from(String(accountId)))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

// Recovery codes: ten characters without look-alikes (no 0/O, 1/I), shown as XXXXX-XXXXX.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const RECOVERY_COUNT = 8

const newRecoveryCode = () => {
  const characters = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)])
  return `${characters.slice(0, 5).join('')}-${characters.slice(5).join('')}`
}

/** Upper-case ten-character form of what a person typed, or null when it cannot be a recovery code. */
const normalizeRecoveryCode = (input) => {
  const text = String(input ?? '').toUpperCase().replace(/[\s-]/g, '')
  return text.length === 10 && [...text].every(character => RECOVERY_ALPHABET.includes(character)) ? text : null
}

// Keyed, so a copy of the database alone is useless for guessing recovery codes offline.
const hashRecoveryCode = normalized => hmac('recovery', normalized, 'hex')

const newRecoveryCodes = () => {
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode)
  return { codes, hashed: codes.map(code => ({ hash: hashRecoveryCode(normalizeRecoveryCode(code)) })) }
}

module.exports = {
  STEP_SECONDS, RECOVERY_COUNT,
  newSecret, otpauthUrl, stepForCode, encryptSecret, decryptSecret,
  newRecoveryCodes, normalizeRecoveryCode, hashRecoveryCode,
}
