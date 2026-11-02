const Session = require('../models/Session')
const { randomToken, sha256 } = require('./crypto')

const DAY_MS = 86_400_000
const TOUCH_INTERVAL_MS = 60_000

const CODES = {
  missing: 'NOT_AUTHENTICATED',
  expired: 'SESSION_EXPIRED',
  revoked: 'SESSION_REVOKED',
}

const MESSAGES = {
  [CODES.missing]: 'Not authenticated',
  [CODES.expired]: 'Your session has expired. Please sign in again.',
  [CODES.revoked]: 'You were signed out. Please sign in again.',
}

const positive = (name, fallback) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// Customers stay signed in while they use the site; administrators get a short leash.
const lifetimes = role => (role === 'admin'
  ? { idleMs: positive('SESSION_ADMIN_IDLE_MINUTES', 30) * 60_000, absoluteMs: positive('SESSION_ADMIN_ABSOLUTE_HOURS', 8) * 3_600_000 }
  : { idleMs: positive('SESSION_CUSTOMER_IDLE_DAYS', 7) * DAY_MS, absoluteMs: positive('SESSION_CUSTOMER_ABSOLUTE_DAYS', 14) * DAY_MS })

const clientAgent = req => String(req?.get?.('user-agent') || '').slice(0, 200)

const createSession = async ({ accountModel, account, role, req, mfaVerified = false }) => {
  const token = randomToken(32)
  const now = Date.now()
  const { idleMs, absoluteMs } = lifetimes(role)
  const absoluteExpiresAt = new Date(now + absoluteMs)
  const session = await Session.create({
    tokenHash: sha256(token),
    accountModel,
    accountId: account._id,
    role,
    lastSeenAt: new Date(now),
    idleExpiresAt: new Date(now + idleMs),
    absoluteExpiresAt,
    expireAt: absoluteExpiresAt,
    ip: req?.ip,
    userAgent: clientAgent(req),
    ...(mfaVerified ? { mfaVerifiedAt: new Date(now) } : {}),
  })
  return { token, session }
}

// The record behind a token whatever its state (used by logout), or { session: null }.
const findSession = async token => ({ session: token ? await Session.findOne({ tokenHash: sha256(token) }) : null })

// Returns { session } only for a usable session; every failure is { code } with no session attached,
// so callers cannot accidentally authenticate with an expired or revoked record.
const findValidSession = async token => {
  if (!token) return { code: CODES.missing }
  const session = await Session.findOne({ tokenHash: sha256(token) })
  if (!session) return { code: CODES.missing }
  if (session.revokedAt) return { code: CODES.revoked }

  const now = Date.now()
  if (now >= session.absoluteExpiresAt.getTime() || now >= session.idleExpiresAt.getTime()) return { code: CODES.expired }

  // Slide the idle window, but write at most once a minute per session.
  if (now - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
    const idleExpiresAt = new Date(Math.min(now + lifetimes(session.role).idleMs, session.absoluteExpiresAt.getTime()))
    await Session.updateOne({ _id: session._id, revokedAt: { $exists: false } }, { $set: { lastSeenAt: new Date(now), idleExpiresAt } })
    session.lastSeenAt = new Date(now)
    session.idleExpiresAt = idleExpiresAt
  }
  return { session }
}

// Cheap liveness check for long-lived connections (sockets): never extends the idle window.
const isSessionActive = async sessionId => {
  const session = await Session.findById(sessionId).select('revokedAt idleExpiresAt absoluteExpiresAt')
  if (!session || session.revokedAt) return false
  const now = Date.now()
  return now < session.absoluteExpiresAt.getTime() && now < session.idleExpiresAt.getTime()
}

const disconnectSockets = (io, sessionIds) => {
  for (const id of sessionIds) io?.in?.(`session-${id}`)?.disconnectSockets?.(true)
}

const revokeSession = async (session, reason, io) => {
  await Session.updateOne({ _id: session._id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokedReason: reason } })
  disconnectSockets(io, [session._id.toString()])
}

// Ends every live session of an account, optionally keeping one (the caller's own).
const revokeAccountSessions = async ({ accountModel, accountId, exceptId, reason, io }) => {
  const filter = { accountModel, accountId, revokedAt: { $exists: false } }
  if (exceptId) filter._id = { $ne: exceptId }
  const live = await Session.find(filter).select('_id')
  if (!live.length) return 0
  await Session.updateMany({ _id: { $in: live.map(item => item._id) } }, { $set: { revokedAt: new Date(), revokedReason: reason } })
  disconnectSockets(io, live.map(item => item._id.toString()))
  return live.length
}

module.exports = {
  CODES,
  MESSAGES,
  createSession,
  findSession,
  findValidSession,
  isSessionActive,
  lifetimes,
  revokeAccountSessions,
  revokeSession,
}
