const { hmac } = require('./crypto')

const isProduction = () => process.env.NODE_ENV === 'production'

// "__Host-" makes browsers refuse the cookie unless it is Secure, host-only and Path=/.
// It needs HTTPS, so local HTTP development keeps the plain name. Fixed when the process starts:
// a cookie that is already in a browser must keep its name for the life of the server.
const COOKIE_NAME = isProduction() ? '__Host-ec_session' : 'ec_session'
const sessionCookieName = () => COOKIE_NAME

const sameSite = () => (String(process.env.SESSION_COOKIE_SAMESITE || '').toLowerCase() === 'lax' ? 'lax' : 'strict')

const cookieOptions = maxAgeMs => ({
  httpOnly: true,
  secure: isProduction(),
  sameSite: sameSite(),
  path: '/',
  maxAge: maxAgeMs,
})

const parseCookies = header => Object.fromEntries(
  String(header || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=')
    if (separator < 0) return [part, '']
    return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))]
  }),
)

const sessionTokenFromRequest = req => parseCookies(req.headers.cookie)[sessionCookieName()] || ''

const csrfTokenForSession = token => hmac('csrf', `csrf:${token}`)

const attachSession = (res, token, maxAgeMs) => {
  res.cookie(sessionCookieName(), token, cookieOptions(maxAgeMs))
  return csrfTokenForSession(token)
}

const clearSession = res => {
  const { maxAge, ...options } = cookieOptions()
  return res.clearCookie(sessionCookieName(), options)
}

module.exports = {
  attachSession,
  clearSession,
  csrfTokenForSession,
  sessionCookieName,
  sessionTokenFromRequest,
}
