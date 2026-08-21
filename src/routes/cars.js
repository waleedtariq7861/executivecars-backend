const express = require('express')
const router = express.Router()
const { getCars, getCarById } = require('../controllers/carController')

router.get('/',    getCars)
router.get('/:id', getCarById)

module.exports = router
