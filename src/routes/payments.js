const express = require('express')
const router = express.Router()
const protect    = require('../middleware/auth')
const { createCheckoutSession, verifySession, completeDemoPayment } = require('../controllers/paymentController')

// Local FYP demonstration only. The authenticated member is derived from the JWT;
// the browser cannot set price, plan, status, or expiry.
router.post('/demo-complete', protect, completeDemoPayment)

// Checkout session — member must be logged in but subscription can be inactive (they're paying to activate)
router.post('/create-checkout-session', protect, createCheckoutSession)

// Verify a completed Stripe session and return fresh subscription status
router.get('/verify-session', protect, verifySession)

module.exports = router
