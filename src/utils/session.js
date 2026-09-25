const crypto = require('crypto')

const SESSION_COOKIE = 'ec_session'

const parseDurationMs = (value = '7d') => {
  const match = String(value).trim().match(/^(\d+)([smhd])$/i)
  if (!match) return 7 * 24 * 60 * 60 * 1000
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return Number(match[1]) * multipliers[match[2].toLowerCase()]
}

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: parseDurationMs(process.env.JWT_EXPIRES_IN),
})

const parseCookies = header => Object.fromEntries(
  String(header || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=')
    if (separator < 0) return [part, '']
    return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))]
  }),
)

const sessionTokenFromRequest = req => parseCookies(req.headers.cookie)[SESSION_COOKIE] || ''

const csrfTokenForSession = token => crypto
  .createHmac('sha256', process.env.JWT_SECRET)
  .update(`csrf:${token}`)
  .digest('base64url')

const attachSession = (res, token) => {
  res.cookie(SESSION_COOKIE, token, cookieOptions())
  return csrfTokenForSession(token)
}

const clearSession = res => res.clearCookie(SESSION_COOKIE, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
})

module.exports = {
  SESSION_COOKIE,
  attachSession,
  clearSession,
  csrfTokenForSession,
  sessionTokenFromRequest,
}
