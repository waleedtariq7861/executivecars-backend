require('dotenv').config()
const http = require('http')
const mongoose = require('mongoose')
const { Server } = require('socket.io')
const connectDB = require('../src/config/db')
const initSocket = require('../src/socket/bidSocket')
const { startAuctionScheduler } = require('../src/utils/auctionScheduler')
const { createApp, allowedOrigins } = require('./app')
const { isDemoMode, validateRuntimeConfig } = require('../src/config/runtime')

const app = createApp()
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : false,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // The only messages the browser sends are auction ids; nothing larger than a few kilobytes is read.
  maxHttpBufferSize: 10_000,
})
app.set('io', io)
initSocket(io)

const port = Number(process.env.PORT) || 5000
let schedulerTimer
let started = false

const start = async () => {
  if (started) return server
  validateRuntimeConfig()
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required')
  await connectDB()
  schedulerTimer = startAuctionScheduler(io)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      server.off('error', reject)
      started = true
      console.log(`Server running on port ${port}`)
      resolve()
    })
  })
  return server
}

const stop = async () => {
  if (schedulerTimer) clearInterval(schedulerTimer)
  await new Promise(resolve => io.close(resolve))
  if (server.listening) await new Promise(resolve => server.close(resolve))
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  started = false
}

const shutdown = signal => {
  console.log(`${signal} received; shutting down gracefully.`)
  stop().then(() => process.exit(0)).catch(error => {
    console.error('Graceful shutdown failed:', error.message)
    process.exit(1)
  })
}

if (require.main === module) {
  start().catch(error => {
    console.error('Server startup failed:', error.message)
    process.exit(1)
  })
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

module.exports = { app, server, io, start, stop }
