const express = require('express')
const router = express.Router()
const { docUpload } = require('../config/cloudinary')
const { sendOTP, verifyOTP, submitBooking } = require('../controllers/bookingController')
const { otpLimiter, bookingLimiter } = require('../middleware/rateLimits')
const verifiedBookingCode = require('../middleware/verifiedBookingCode')
const protect = require('../middleware/auth')
const memberAccountOnly = require('../middleware/memberAccountOnly')

router.use(protect, memberAccountOnly)

router.post('/send-otp',    otpLimiter, sendOTP)
router.post('/verify-otp',  otpLimiter, verifyOTP)
router.post('/',            bookingLimiter, verifiedBookingCode, docUpload, submitBooking)

module.exports = router
