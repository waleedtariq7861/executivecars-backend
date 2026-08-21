const axios = require('axios')
const Product = require('../models/Product')
const { escapeRegex } = require('../utils/http')

const FALLBACK_VERSION = 'comparable-median-v1'

const text = value => String(value || '').trim()
const number = value => {
  const validSyntax = typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
  const parsed = validSyntax ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}
const percentile = (values, ratio) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * ratio
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}
const roundPrice = value => Math.round(value / 1000) * 1000

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

const comparableDistance = (input, listing) => {
  const modelPenalty = text(listing.model).toLowerCase() === input.model.toLowerCase() ? 0 : 0.7
  const yearDistance = Math.min(1, Math.abs(Number(listing.year) - input.year) / 8)
  const mileageDistance = Math.min(1, Math.abs(Number(listing.km || 0) - input.mileage) / 200000)
  const transmissionPenalty = input.transmission && listing.transmission !== input.transmission ? 0.15 : 0
  const cityPenalty = input.city && listing.city && listing.city.toLowerCase() !== input.city.toLowerCase() ? 0.08 : 0
  const engine = number(String(listing.engine || '').replace(/[^0-9.]/g, ''))
  const engineDistance = input.engineCapacity && engine
    ? Math.min(0.3, Math.abs(engine - input.engineCapacity) / 5000)
    : 0.05
  return modelPenalty + yearDistance * 0.45 + mileageDistance * 0.25 + transmissionPenalty + cityPenalty + engineDistance
}

const buildFactors = (input, comparables) => {
  const factors = []
  const exactModels = comparables.filter(item => text(item.model).toLowerCase() === input.model.toLowerCase()).length
  factors.push(`${exactModels} of ${comparables.length} comparables match the same model`)
  const medianYear = Math.round(percentile(comparables.map(item => Number(item.year)), 0.5))
  const medianMileage = Math.round(percentile(comparables.map(item => Number(item.km || 0)), 0.5))
  if (input.year > medianYear) factors.push(`Model year is newer than the comparable median (${medianYear})`)
  else if (input.year < medianYear) factors.push(`Model year is older than the comparable median (${medianYear})`)
  if (input.mileage < medianMileage) factors.push(`Mileage is below the comparable median (${medianMileage.toLocaleString()} km)`)
  else if (input.mileage > medianMileage) factors.push(`Mileage is above the comparable median (${medianMileage.toLocaleString()} km)`)
  if (input.condition) factors.push(`Declared condition: ${input.condition}`)
  return factors.slice(0, 4)
}

const comparableFallback = async input => {
  const makeMatcher = new RegExp(`^${escapeRegex(input.make)}$`, 'i')
  const candidates = await Product.find({
    status: 'available',
    make: makeMatcher,
    price: { $gt: 0 },
  }).select('make model variant year km price engine transmission city condition updatedAt createdAt').limit(500).lean()

  if (!candidates.length) {
    const error = new Error(`No local comparable listings are available for ${input.make}.`)
    error.status = 503
    throw error
  }

  const ranked = candidates
    .map(listing => ({ listing, distance: comparableDistance(input, listing) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 25)
  const close = ranked.filter(item => item.distance <= 1.15)
  const selected = (close.length >= 2 ? close : ranked.slice(0, Math.min(8, ranked.length)))
  const prices = selected.map(item => Number(item.listing.price)).filter(value => Number.isFinite(value) && value > 0)

  if (!prices.length) {
    const error = new Error('Comparable listings do not contain usable prices.')
    error.status = 503
    throw error
  }

  const estimate = roundPrice(percentile(prices, 0.5))
  const sparseMargin = selected.length < 4 ? 0.15 : 0.1
  const lowerQuartile = percentile(prices, 0.25)
  const upperQuartile = percentile(prices, 0.75)
  const low = roundPrice(Math.min(lowerQuartile, estimate * (1 - sparseMargin)))
  const high = roundPrice(Math.max(upperQuartile, estimate * (1 + sparseMargin)))
  const freshness = selected
    .map(item => item.listing.updatedAt || item.listing.createdAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0]

  return {
    estimatedMarketPrice: estimate,
    estimatedPrice: estimate,
    predicted: estimate,
    lowerRange: low,
    upperRange: high,
    recommendedRange: { low, high },
    range: { low, high },
    currency: 'PKR',
    modelName: 'Comparable median fallback',
    modelMetrics: null,
    rangeMethod: {
      method: 'comparable_interquartile_range',
      comparableRows: selected.length,
      note: 'The interval uses the selected comparable-price quartiles with an added sparse-data margin.',
    },
    comparableVehicleCount: selected.length,
    mainPricingFactors: buildFactors(input, selected.map(item => item.listing)),
    importantFactors: buildFactors(input, selected.map(item => item.listing)),
    marketDemand: selected.length >= 12 ? 'high listing activity' : selected.length >= 5 ? 'moderate listing activity' : 'limited listing activity',
    predictedDepreciation: null,
    modelVersion: FALLBACK_VERSION,
    dataFreshnessDate: freshness ? new Date(freshness).toISOString() : null,
    method: 'comparable_median',
    isFallback: true,
    disclaimer: 'Estimated from current Executive Cars comparable listings; it is not a guaranteed sale price or offer.',
    note: 'Comparable-listing fallback estimate; a trained ML model was not used.',
  }
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
    const unavailable = new Error('The trained valuation service is unavailable. Please try again later.')
    unavailable.status = 503
    throw unavailable
  }
  const unavailable = new Error('The trained valuation service is unavailable. Please try again later.')
  unavailable.status = 503
  throw unavailable
}

module.exports = { FALLBACK_VERSION, validateInput, predictPrice, comparableFallback, modelOptions }
