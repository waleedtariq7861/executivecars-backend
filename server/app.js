const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const mongoose = require('mongoose')
const { predictionLimiter } = require('../src/middleware/rateLimits')
const { publicImageDir } = require('../src/config/cloudinary')
const csrfProtection = require('../src/middleware/csrf')

const { allowedOrigins } = require('../src/config/origins')
const corsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true)
    const error = new Error('Origin is not allowed by CORS')
    error.status = 403
    return callback(error)
  },
}

const trustedProxyHops = (env = process.env) => {
  const hops = env.TRUST_PROXY_HOPS === undefined || env.TRUST_PROXY_HOPS === '' ? 1 : Number(env.TRUST_PROXY_HOPS)
  if (!Number.isInteger(hops) || hops < 1 || hops > 5) throw new Error('TRUST_PROXY_HOPS must be a whole number from 1 to 5')
  return hops
}

const createApp = ({ io } = {}) => {
  const app = express()
  app.disable('x-powered-by')
  // Query strings are flat text: ?status[$ne]=x is just a parameter with an odd name, never a database operator.
  app.set('query parser', 'simple')
  // How many reverse proxies sit in front of the API (Render alone: 1; Vercel in front of Render: 2). Wrong values make
  // every visitor share one address in the rate limits, or let a visitor choose theirs.
  app.set('trust proxy', trustedProxyHops())
  if (io) app.set('io', io)

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))

  app.use(cors(corsOptions))
  app.use(csrfProtection(allowedOrigins))
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: false, limit: '1mb' }))
  // Only vehicle imagery is public. Identity documents and inspection reports
  // are stored outside this mount and served through authorized short-lived URLs.
  app.use('/uploads/images', express.static(publicImageDir, { maxAge: '1d', fallthrough: true }))

  app.use('/api/auth', require('../src/routes/auth'))
  app.use('/api/bookings', require('../src/routes/bookings'))
  app.use('/api/cars', require('../src/routes/cars'))
  app.use('/api/products', require('../src/routes/products'))
  app.use('/api/admin', require('../src/routes/admin'))
  app.use('/api/member', require('../src/routes/member'))
  app.use('/api/seller', require('../src/routes/seller'))
  app.use('/api/bids', require('../src/routes/bids'))
  app.use('/api/payments', require('../src/routes/payments'))
  app.use('/api/predict-price', predictionLimiter, require('../src/routes/predict'))
  app.use('/api/predict', predictionLimiter, require('../src/routes/predict'))
  app.use('/api/vehicle-catalog', require('../src/routes/vehicleCatalog'))
  app.use('/api/vehicle-options', require('../src/routes/vehicleOptions'))
  app.use('/api/chat', require('../src/routes/chat'))
  app.use('/api/documents', require('../src/routes/documents'))

  app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  }))

  app.use((req, res) => res.status(404).json({ message: 'Route not found' }))

  app.use((err, req, res, next) => {
    if (process.env.NODE_ENV !== 'test') console.error(err.stack || err.message)
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'Each uploaded file must be 10 MB or smaller' })
    if (err.name === 'MulterError') return res.status(400).json({ message: err.message })
    const status = err.status || 500
    const message = status >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error'
    return res.status(status).json({ message })
  })

  return app
}

module.exports = { createApp, corsOptions, allowedOrigins, trustedProxyHops }
