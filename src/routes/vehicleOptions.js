const router = require('express').Router()
const { vehicleOptions } = require('../services/vehicleOptionsService')

router.get('/', async (req, res, next) => {
  try {
    res.json(await vehicleOptions(req.query))
  } catch (error) {
    next(error)
  }
})

module.exports = router
