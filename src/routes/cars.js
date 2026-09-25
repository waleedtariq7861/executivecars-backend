const express = require('express')
const router = express.Router()
const { getCars, getCarById } = require('../controllers/carController')
const protect = require('../middleware/auth')
const memberOnly = require('../middleware/memberOnly')

// Full auction inventory is a paid-member capability. Public pages use their
// own static marketing copy and must not be able to enumerate this collection.
router.use(protect, memberOnly)

router.get('/', getCars)
router.get('/:id', getCarById)

module.exports = router
