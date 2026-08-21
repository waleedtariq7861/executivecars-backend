const { rateLimit } = require('express-rate-limit')

const createLimiter = ({ windowMs, limit, message }) => rateLimit({
  windowMs,
  limit,
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message },
})

const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many sign-in attempts. Please try again in 15 minutes.',
})

const otpLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: 'Too many verification requests. Please try again later.',
})

const predictionLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  message: 'Too many valuation requests. Please wait a minute and try again.',
})

const chatLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  message: 'Too many assistant requests. Please wait a minute and try again.',
})

module.exports = { authLimiter, otpLimiter, predictionLimiter, chatLimiter }
