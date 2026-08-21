const router = require('express').Router()
const { vehicleOptions } = require('../services/vehicleOptionsService')

router.get('/', (req, res) => res.json(vehicleOptions(req.query)))

module.exports = router
