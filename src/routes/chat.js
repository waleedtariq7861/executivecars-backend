const express = require('express')
const router = express.Router()
const { chat, chatHealth } = require('../controllers/chatController')
const { chatLimiter } = require('../middleware/rateLimits')

router.get('/health', chatHealth)
router.post('/', chatLimiter, chat)

module.exports = router
