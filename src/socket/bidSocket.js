const jwt = require('jsonwebtoken')
const mongoose = require('mongoose')

const initSocket = (io) => {
  // Authenticate socket connections
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (!token) return next(new Error('Authentication required'))
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      socket.userId   = decoded.id
      socket.userRole = decoded.role
      next()
    } catch {
      next(new Error('Invalid token'))
    }
  })

  io.on('connection', (socket) => {
    // Join user's personal room to receive outbid notifications
    socket.join(`user-${socket.userId}`)

    // Join an auction room to receive live bid updates
    socket.on('join-auction', (carId) => {
      if (mongoose.isValidObjectId(carId)) socket.join(carId)
    })

    // Leave an auction room
    socket.on('leave-auction', (carId) => {
      if (mongoose.isValidObjectId(carId)) socket.leave(carId)
    })
  })
}

module.exports = initSocket
