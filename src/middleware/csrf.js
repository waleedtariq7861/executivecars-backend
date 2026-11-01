const crypto = require('crypto')
const { csrfTokenForSession, sessionTokenFromRequest } = require('../utils/session')

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// Signing out must work even when the CSRF token can no longer be derived (stale or expired session);
// forcing a sign-out is harmless, so only the Origin is checked.
const ORIGIN_ONLY_PATHS = new Set(['/api/auth/logout'])
const UNAUTHENTICATED_AUTH_PATHS = new Set([
  '/api/auth/admin/login',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/member/register',
  '/api/auth/member/login',
  '/api/auth/seller/login',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
])

const safelyEqual = (left, right) => {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const csrfProtection = allowedOrigins => (req, res, next) => {
  if (SAFE_METHODS.has(req.method) || UNAUTHENTICATED_AUTH_PATHS.has(req.path)) return next()
  const sessionToken = sessionTokenFromRequest(req)
  if (!sessionToken) return next()

  const origin = String(req.get('origin') || '').replace(/\/$/, '')
  if (!origin || !allowedOrigins.includes(origin)) {
    return res.status(403).json({ message: 'Request origin could not be verified' })
  }
  if (ORIGIN_ONLY_PATHS.has(req.path)) return next()

  const supplied = req.get('x-csrf-token')
  if (!safelyEqual(supplied, csrfTokenForSession(sessionToken))) {
    return res.status(403).json({ message: 'Invalid CSRF token' })
  }
  return next()
}

module.exports = csrfProtection
