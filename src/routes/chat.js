const express = require('express')
const router = express.Router()
const { chat } = require('../controllers/chatController')
const { chatLimiter } = require('../middleware/rateLimits')

router.post('/', chatLimiter, chat)

module.exports = router
