const express = require('express')
const router = express.Router()
const protect = require('../middleware/auth')
const { authLimiter } = require('../middleware/rateLimits')
const { adminLogin, accountRegister, accountLogin, memberRegister, memberLogin, sellerLogin, changePassword, requestPasswordReset, resetPassword } = require('../controllers/authController')

router.post('/admin/login',     authLimiter, adminLogin)
router.post('/register',        authLimiter, accountRegister)
router.post('/login',           authLimiter, accountLogin)
router.post('/member/register', authLimiter, memberRegister)
router.post('/member/login',    authLimiter, memberLogin)
router.post('/seller/login',    authLimiter, sellerLogin)
router.post('/change-password', protect, changePassword)
router.post('/forgot-password', authLimiter, requestPasswordReset)
router.post('/reset-password',  authLimiter, resetPassword)

module.exports = router
