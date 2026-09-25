const express = require('express')
const router = express.Router()
const protect    = require('../middleware/auth')
const { completeDemoPayment } = require('../controllers/paymentController')
const { demoPaymentsEnabled } = require('../config/auctionMembership')

// Local FYP demonstration only. The authenticated member is derived from the JWT;
// the browser cannot set price, plan, status, or expiry.
if (demoPaymentsEnabled()) router.post('/demo-complete', protect, completeDemoPayment)

module.exports = router
