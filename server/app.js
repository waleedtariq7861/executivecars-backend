const express = require('express')
const path = require('path')
const cors = require('cors')
const helmet = require('helmet')
const mongoose = require('mongoose')
const { handleWebhook } = require('../src/controllers/paymentController')
const { predictionLimiter } = require('../src/middleware/rateLimits')

const configuredOrigins = [process.env.CLIENT_URL, ...(process.env.CLIENT_URLS || '').split(',')]
  .map(value => value?.trim().replace(/\/$/, ''))
  .filter(Boolean)

if (process.env.NODE_ENV !== 'production') {
  configuredOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173')
}

const allowedOrigins = [...new Set(configuredOrigins)]
const corsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) return callback(null, true)
    const error = new Error('Origin is not allowed by CORS')
    error.status = 403
    return callback(error)
  },
}

const createApp = ({ io } = {}) => {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  if (io) app.set('io', io)

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))

  // Stripe requires the untouched request bytes when validating webhooks.
  app.post('/api/payments/webhook', cors(corsOptions), express.raw({ type: 'application/json', limit: '256kb' }), handleWebhook)

  app.use(cors(corsOptions))
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true, limit: '1mb' }))
  app.use('/uploads', express.static(path.resolve(__dirname, '..', 'uploads'), { maxAge: '1d', fallthrough: true }))

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

module.exports = { createApp, corsOptions, allowedOrigins }
