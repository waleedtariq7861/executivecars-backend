const express = require('express')
const router = express.Router()
const protect = require('../middleware/auth')
const { loginLimiter, adminLoginLimiter, registerLimiter, forgotPasswordLimiter, resetPasswordLimiter } = require('../middleware/rateLimits')
const { adminLogin, accountRegister, accountLogin, memberRegister, memberLogin, sellerLogin, changePassword, requestPasswordReset, resetPassword, session, logout } = require('../controllers/authController')

router.post('/admin/login',     adminLoginLimiter, adminLogin)
router.post('/register',        registerLimiter, accountRegister)
router.post('/login',           loginLimiter, accountLogin)
router.post('/member/register', registerLimiter, memberRegister)
router.post('/member/login',    loginLimiter, memberLogin)
router.post('/seller/login',    loginLimiter, sellerLogin)
router.post('/change-password', protect, changePassword)
router.get('/session',             protect, session)
router.post('/logout',             logout)
router.post('/forgot-password', forgotPasswordLimiter, requestPasswordReset)
router.post('/reset-password',  resetPasswordLimiter, resetPassword)

module.exports = router
