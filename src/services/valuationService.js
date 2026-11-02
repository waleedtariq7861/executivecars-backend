const axios = require('axios')

const text = value => String(value || '').trim()
const number = value => {
  const validSyntax = typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
  const parsed = validSyntax ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}
const normalizeInput = payload => ({
  make: text(payload.make || payload.brand),
  model: text(payload.model),
  variant: text(payload.variant),
  year: number(payload.year ?? payload.modelYear),
  mileage: number(payload.mileage ?? payload.km),
  engineCapacity: number(payload.engineCapacity ?? payload.engine),
  transmission: text(payload.transmission),
  fuelType: text(payload.fuelType || payload.fuel),
  city: text(payload.city || payload.listingCity),
  registrationCity: text(payload.registrationCity || payload.registered),
  condition: text(payload.condition),
  assemblyType: text(payload.assemblyType),
  bodyType: text(payload.bodyType),
  colour: text(payload.colour || payload.color),
  inspectionScore: number(payload.inspectionScore),
  numberOfOwners: number(payload.numberOfOwners),
})

const validateInput = payload => {
  const input = normalizeInput(payload || {})
  const currentYear = new Date().getFullYear()
  const errors = {}
  if (!input.make) errors.make = 'Make is required.'
  if (!input.model) errors.model = 'Model is required.'
  if (!Number.isInteger(input.year) || input.year < 1980 || input.year > currentYear + 1) errors.year = 'Enter a valid model year.'
  if (input.mileage === null || input.mileage < 0 || input.mileage > 1000000) errors.mileage = 'Mileage must be between 0 and 1,000,000 km.'
  if (input.engineCapacity === null || input.engineCapacity < 400 || input.engineCapacity > 10000) errors.engineCapacity = 'Engine capacity must be between 400 and 10,000 cc.'
  if (input.inspectionScore !== null && (input.inspectionScore < 0 || input.inspectionScore > 100)) errors.inspectionScore = 'Inspection score must be between 0 and 100.'
  return { input, errors }
}

const serviceBase = () => String(process.env.ML_SERVICE_URL || process.env.ML_API_URL || 'http://127.0.0.1:8000')
  .replace(/\/predict\/?$/, '')
  .replace(/\/$/, '')

const serviceHeaders = () => process.env.ML_SERVICE_KEY
  ? { 'X-Service-Key': process.env.ML_SERVICE_KEY }
  : undefined

const predictionUrl = () => {
  const configured = text(process.env.ML_API_URL)
  return /\/predict\/?$/.test(configured) ? configured.replace(/\/$/, '') : `${serviceBase()}/predict`
}

const modelOptions = async () => {
  if (!process.env.ML_API_URL && !process.env.ML_SERVICE_URL) {
    return { available: false, message: 'The trained model service is not configured.' }
  }
  try {
    const { data } = await axios.get(`${serviceBase()}/metadata`, {
      timeout: 4000,
      headers: serviceHeaders(),
    })
    return { available: true, ...data }
  } catch {
    return { available: false, message: 'The trained model metadata is currently unavailable.' }
  }
}

const modelPrediction = async input => {
  if (!process.env.ML_API_URL && !process.env.ML_SERVICE_URL) return null
  let response
  try {
    response = await axios.post(predictionUrl(), input, {
      timeout: 8000,
      headers: serviceHeaders(),
    })
  } catch (error) {
    if (error.response?.status === 422) {
      const detail = error.response.data?.detail
      const validationError = new Error(detail?.message || 'The selected make/model is not supported by the active training dataset.')
      validationError.status = 400
      validationError.errors = detail?.errors || {}
      throw validationError
    }
    throw error
  }
  const data = response.data || {}
  const estimate = number(data.predicted_price ?? data.estimatedPrice ?? data.estimatedMarketPrice ?? data.predicted)
  if (!estimate || estimate <= 0) throw new Error('Prediction service returned an invalid estimate')
  const low = number(data.lowerRange ?? data.recommendedRange?.low ?? data.range?.low)
  const high = number(data.upperRange ?? data.recommendedRange?.high ?? data.range?.high)
  return {
    ...data,
    predicted_price: estimate,
    estimatedPrice: estimate,
    estimatedMarketPrice: estimate,
    predicted: estimate,
    lowerRange: low,
    upperRange: high,
    recommendedRange: data.recommendedRange || data.range || { low, high },
    range: data.range || data.recommendedRange || { low, high },
    isFallback: false,
  }
}

const predictPrice = async input => {
  try {
    const prediction = await modelPrediction(input)
    if (prediction) return prediction
  } catch (error) {
    if (error.status === 400) throw error
  }
  const unavailable = new Error('The trained valuation service is unavailable. Please try again later.')
  unavailable.status = 503
  throw unavailable
}

module.exports = { validateInput, predictPrice, modelOptions }
