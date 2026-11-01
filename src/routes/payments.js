const express = require('express')
const router = express.Router()
const protect = require('../middleware/auth')
const memberAccountOnly = require('../middleware/memberAccountOnly')
const verifiedEmail = require('../middleware/verifiedEmail')
const { paymentLimiter } = require('../middleware/rateLimits')
const { plan, methods, createPayment, payPayment, listMyPayments, getPayment, getInvoice } = require('../controllers/paymentController')

// What is for sale and which methods exist: public, so the pricing page can show them before sign-in.
router.get('/plan', plan)
router.get('/methods', methods)

router.use(protect, memberAccountOnly)
router.get('/', listMyPayments)
router.post('/', verifiedEmail, paymentLimiter, createPayment)
router.get('/:id', getPayment)
router.post('/:id/pay', verifiedEmail, paymentLimiter, payPayment)
router.get('/:id/invoice', getInvoice)

module.exports = router
