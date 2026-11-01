const express = require('express')
const router = express.Router()
const protect    = require('../middleware/auth')
const memberOnly = require('../middleware/memberOnly')
const verifiedEmail = require('../middleware/verifiedEmail')
const { placeBid, getBidHistory } = require('../controllers/bidController')

router.post('/', protect, verifiedEmail, memberOnly, placeBid)
router.get('/:carId', protect, memberOnly, getBidHistory)

module.exports = router
