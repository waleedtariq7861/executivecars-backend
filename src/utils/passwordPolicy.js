const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// NIST SP 800-63B / OWASP ASVS V6.2: length and a blocklist, no composition rules, any characters allowed.
const MIN_LENGTH = 8
const MAX_LENGTH = 128
const HIBP_TIMEOUT_MS = 1500

let commonPasswords
const getCommonPasswords = () => {
  if (!commonPasswords) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'data', 'common-passwords.txt'), 'utf8')
    commonPasswords = new Set(text.split(/\r?\n/).map(line => line.trim().toLowerCase()).filter(Boolean))
  }
  return commonPasswords
}

const compact = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

// "password123" and "Summer2024!" are the common word plus a decoration. Compare the password as typed and
// without its trailing digits/symbols, against the whole list (short words included), so the decoration
// does not turn a well-known password into an acceptable one.
const isCommon = (password) => {
  const lower = password.toLowerCase()
  const common = getCommonPasswords()
  const stem = lower.replace(/[^\p{L}]+$/u, '')
  return common.has(lower) || (stem.length >= 4 && common.has(stem)) || new Set(lower).size === 1
}

// Words an attacker tries first for this particular person or site.
const personalWords = ({ email, name } = {}) => {
  const words = new Set(['executivecars'])
  const local = compact(String(email || '').split('@')[0])
  if (local.length >= 4) words.add(local)
  for (const part of String(name || '').split(/\s+/)) {
    const word = compact(part)
    if (word.length >= 5) words.add(word)
  }
  return [...words]
}

const hibpEnabled = () => {
  const flag = String(process.env.HIBP_ENABLED || '').toLowerCase()
  if (flag === 'true') return true
  if (flag === 'false') return false
  return process.env.NODE_ENV === 'production'
}

// Have I Been Pwned range API (k-anonymity): only the first 5 characters of the SHA-1 leave this server.
// Any failure (timeout, outage, bad response) lets the password through: a third-party outage must not block sign-up.
const isBreached = async (password, fetchImpl = globalThis.fetch) => {
  if (typeof fetchImpl !== 'function') return false
  try {
    const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase()
    const prefix = sha1.slice(0, 5)
    const suffix = sha1.slice(5)
    const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'executive-cars-password-check' },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const body = await response.text()
    return body.split(/\r?\n/).some(line => {
      const [hashSuffix, count] = line.trim().split(':')
      return hashSuffix === suffix && Number(count) > 0
    })
  } catch {
    return false
  }
}

const fail = (code, message) => ({ ok: false, code, message })

/**
 * @param {string} password
 * @param {{ email?: string, name?: string }} context personal details the password must not echo
 * @param {{ fetchImpl?: Function, checkBreaches?: boolean }} options
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
 */
const validatePassword = async (password, context = {}, options = {}) => {
  if (typeof password !== 'string') return fail('PASSWORD_REQUIRED', 'Enter a password.')
  const length = [...password].length
  if (length < MIN_LENGTH) return fail('PASSWORD_TOO_SHORT', `Use at least ${MIN_LENGTH} characters.`)
  if (length > MAX_LENGTH) return fail('PASSWORD_TOO_LONG', `Use at most ${MAX_LENGTH} characters.`)

  if (isCommon(password)) {
    return fail('PASSWORD_COMMON', 'This password is too common. Choose something harder to guess.')
  }
  const squashed = compact(password)
  if (personalWords(context).some(word => squashed.includes(word))) {
    return fail('PASSWORD_CONTAINS_PERSONAL', 'Do not use your name, your email or the site name in your password.')
  }

  const checkBreaches = options.checkBreaches ?? hibpEnabled()
  if (checkBreaches && await isBreached(password, options.fetchImpl)) {
    return fail('PASSWORD_BREACHED', 'This password has appeared in a known data breach. Choose a different one.')
  }
  return { ok: true }
}

module.exports = { validatePassword, isBreached, MIN_LENGTH, MAX_LENGTH }
