const Member = require('../models/Member')
const { sessionTokenFromRequest } = require('../utils/session')
const sessions = require('../utils/sessions')
const { allowedOrigins } = require('../config/origins')

const MEMBERSHIP_RECHECK_MS = 60_000
// A member watches a handful of auctions at once. Each join also costs database lookups, so both the number of rooms
// and the rate of join requests on one connection are limited.
const MAX_AUCTION_ROOMS = 20
const JOIN_WINDOW_MS = 10_000
const MAX_JOINS_PER_WINDOW = 20
const OBJECT_ID = /^[a-f0-9]{24}$/i

const activeMember = async id => {
  const member = await Member.findById(id).select('subscriptionStatus subscriptionExpiry')
  return member?.hasActiveSubscription() ? member : null
}

const initSocket = (io) => {
  io.use(async (socket, next) => {
    // Browsers always say where a WebSocket comes from; a page on another site must not open one with this visitor's cookie.
    const origin = String(socket.handshake.headers?.origin || '').replace(/\/$/, '')
    if (origin && !allowedOrigins.includes(origin)) return next(new Error('Origin not allowed'))

    // The session lives in the HttpOnly cookie only; a token supplied by page script is never accepted.
    const token = sessionTokenFromRequest({ headers: socket.handshake.headers })
    if (!token) return next(new Error('Authentication required'))

    try {
      const { session } = await sessions.findValidSession(token)
      if (!session) return next(new Error('Invalid token'))
      if (session.role !== 'user' || session.accountModel !== 'member') return next(new Error('Active membership required'))

      const member = await activeMember(session.accountId)
      if (!member) return next(new Error('Active membership required'))
      socket.userId = member._id.toString()
      socket.sessionId = session._id.toString()
      next()
    } catch {
      next(new Error('Unable to verify session'))
    }
  })

  io.on('connection', (socket) => {
    socket.join(`user-${socket.userId}`)
    // Revoking a session disconnects exactly the sockets that were opened with it.
    socket.join(`session-${socket.sessionId}`)
    const desiredAuctions = new Set()

    const recheckAccess = async () => {
      try {
        if (!(await sessions.isSessionActive(socket.sessionId)) || !(await activeMember(socket.userId))) {
          socket.disconnect(true)
          return false
        }
        return true
      } catch {
        socket.disconnect(true)
        return false
      }
    }

    // Revoke room access when a subscription or session expires or is cancelled.
    const recheckTimer = setInterval(recheckAccess, MEMBERSHIP_RECHECK_MS)
    recheckTimer.unref?.()
    socket.on('disconnect', () => clearInterval(recheckTimer))

    let windowStartedAt = Date.now()
    let joinsInWindow = 0
    const withinJoinRate = () => {
      const now = Date.now()
      if (now - windowStartedAt > JOIN_WINDOW_MS) { windowStartedAt = now; joinsInWindow = 0 }
      joinsInWindow += 1
      return joinsInWindow <= MAX_JOINS_PER_WINDOW
    }

    socket.on('join-auction', async (carId) => {
      if (typeof carId !== 'string' || !OBJECT_ID.test(carId)) return
      if (!withinJoinRate()) return
      if (!desiredAuctions.has(carId) && desiredAuctions.size >= MAX_AUCTION_ROOMS) return
      desiredAuctions.add(carId)
      if (await recheckAccess() && !socket.disconnected && desiredAuctions.has(carId)) {
        socket.join(carId)
      }
    })

    socket.on('leave-auction', (carId) => {
      if (typeof carId !== 'string' || !OBJECT_ID.test(carId)) return
      desiredAuctions.delete(carId)
      socket.leave(carId)
    })
  })
}

module.exports = initSocket
