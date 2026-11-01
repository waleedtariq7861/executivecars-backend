const mongoose = require('mongoose')
const Member = require('../models/Member')
const { sessionTokenFromRequest } = require('../utils/session')
const sessions = require('../utils/sessions')

const MEMBERSHIP_RECHECK_MS = 60_000

const activeMember = async id => {
  const member = await Member.findById(id).select('subscriptionStatus subscriptionExpiry')
  return member?.hasActiveSubscription() ? member : null
}

const initSocket = (io) => {
  io.use(async (socket, next) => {
    const token = sessionTokenFromRequest({ headers: socket.handshake.headers }) || socket.handshake.auth?.token
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

    socket.on('join-auction', async (carId) => {
      if (!mongoose.isValidObjectId(carId)) return
      desiredAuctions.add(carId)
      if (await recheckAccess() && !socket.disconnected && desiredAuctions.has(carId)) {
        socket.join(carId)
      }
    })

    socket.on('leave-auction', (carId) => {
      if (!mongoose.isValidObjectId(carId)) return
      desiredAuctions.delete(carId)
      socket.leave(carId)
    })
  })
}

module.exports = initSocket
