const express = require('express')
const Product = require('../models/Product')
const { validateInput, predictPrice, modelOptions, FALLBACK_VERSION } = require('../services/valuationService')
const { normalizeForMl, validateConfiguration } = require('../data/vehicleCatalog')
const { validateDatasetConfiguration } = require('../services/vehicleOptionsService')

const router = express.Router()

router.get('/health', async (req, res, next) => {
  try {
    const comparableRecords = await Product.countDocuments({ status: 'available', price: { $gt: 0 } })
    res.json({
      status: 'ok',
      modelServiceConfigured: Boolean(process.env.ML_API_URL),
      fallbackVersion: FALLBACK_VERSION,
      comparableRecords,
    })
  } catch (error) {
    next(error)
  }
})

router.get('/options', async (req, res) => {
  const options = await modelOptions()
  res.json(options)
})

router.post('/', async (req, res, next) => {
  try {
    const { input, errors } = validateInput(req.body)
    if (Object.keys(errors).length) {
      return res.status(400).json({ message: 'Please correct the invalid valuation fields.', errors })
    }
    const configurationErrors = validateConfiguration(input)
    if (Object.keys(configurationErrors).length) return res.status(400).json({ message: 'Please correct the vehicle configuration.', errors: configurationErrors })
    const datasetErrors = validateDatasetConfiguration(input)
    if (Object.keys(datasetErrors).length) return res.status(400).json({ message: 'Please correct the vehicle configuration.', errors: datasetErrors })
    const result = await predictPrice(normalizeForMl(input))
    return res.json(result)
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({
        message: error.message,
        errors: error.errors || {},
      })
    }
    return next(error)
  }
})

module.exports = router
