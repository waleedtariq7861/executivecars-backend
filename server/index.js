require('dotenv').config()
const http = require('http')
const mongoose = require('mongoose')
const { Server } = require('socket.io')
const connectDB = require('../src/config/db')
const Admin = require('../src/models/Admin')
const initSocket = require('../src/socket/bidSocket')
const { startAuctionScheduler } = require('../src/utils/auctionScheduler')
const { createApp, allowedOrigins } = require('./app')

const app = createApp()
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : false,
    methods: ['GET', 'POST'],
    credentials: true,
  },
})
app.set('io', io)
initSocket(io)

const port = Number(process.env.PORT) || 5000
let schedulerTimer
let started = false

const ensureDevelopmentAdmin = async () => {
  if (process.env.NODE_ENV === 'production') return
  const email = String(process.env.DEV_ADMIN_EMAIL || '').trim().toLowerCase()
  const password = String(process.env.DEV_ADMIN_PASSWORD || '')
  if (!email || !password) {
    console.warn('Development admin seed skipped: set DEV_ADMIN_EMAIL and DEV_ADMIN_PASSWORD to enable it.')
    return
  }
  const existing = await Admin.findOne({ email })
  if (!existing) {
    await Admin.create({ name: 'Local Admin', email, password, role: 'admin' })
    return
  }
  if (!(await existing.matchPassword(password))) {
    existing.password = password
    await existing.save()
  }
}

const start = async () => {
  if (started) return server
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required')
  await connectDB()
  await ensureDevelopmentAdmin()
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
