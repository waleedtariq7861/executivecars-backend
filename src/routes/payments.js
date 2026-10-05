const express = require('express')
const router = express.Router()
const protect    = require('../middleware/auth')
const { completeDemoPayment } = require('../controllers/paymentController')
const { demoPaymentsEnabled, membershipCapabilities } = require('../config/auctionMembership')

router.get('/capabilities', (req, res) => {
  res.set('Cache-Control', 'no-store').json(membershipCapabilities())
})

// One existing simulation flow for local and explicitly enabled hosted FYP use.
// Every mutation checks the server capability; the browser cannot enable it.
router.post('/demo-complete', (req, res, next) => {
  if (!demoPaymentsEnabled()) return res.status(404).json({
    message: 'Membership activation is currently unavailable.', code: 'MEMBERSHIP_UNAVAILABLE',
  })
  next()
}, protect, completeDemoPayment)

module.exports = router
