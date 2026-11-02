const { rateLimit } = require('express-rate-limit')

const createLimiter = ({ windowMs, limit, message, skipSuccessfulRequests = false }) => rateLimit({
  windowMs,
  limit,
  skipSuccessfulRequests,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message, code: 'RATE_LIMITED' },
})

// Sign-in attempts are also throttled per account and address in MongoDB (utils/loginThrottle.js); these
// limiters are a coarse flood guard per process. Each endpoint has its own budget, so a busy login page
// cannot lock people out of registering or resetting a password.
const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts. Please try again in 15 minutes.',
})

const adminLoginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts. Please try again in 15 minutes.',
})

const registerLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 15,
  message: 'Too many accounts were created from this connection. Please try again later.',
})

const forgotPasswordLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  message: 'Too many password reset requests. Please try again in 15 minutes.',
})

const resetPasswordLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many password reset attempts. Please try again in 15 minutes.',
})

const emailVerificationLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: 'Too many verification requests. Please try again later.',
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

module.exports = { loginLimiter, adminLoginLimiter, registerLimiter, forgotPasswordLimiter, resetPasswordLimiter, emailVerificationLimiter, otpLimiter, predictionLimiter, chatLimiter }
