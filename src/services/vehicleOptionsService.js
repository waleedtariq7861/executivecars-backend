const axios = require('axios')
const { catalog, findVehicle } = require('../data/vehicleCatalog')
const { isConfigured, serviceBase, serviceHeaders } = require('./modelServiceClient')

// The list of makes, models, years and specifications the model was trained on belongs to the model service.
// It is fetched from there and kept in memory: it only changes when the model service is deployed again.
const REFRESH_AFTER_MS = 60 * 60 * 1000
let cached = null
let loading = null

const unavailable = () => Object.assign(new Error('The vehicle list is temporarily unavailable.'), { status: 503 })

const fetchIndex = async () => {
  const { data } = await axios.get(`${serviceBase()}/vehicle-options`, { timeout: 8000, headers: serviceHeaders() })
  if (!Array.isArray(data?.makes)) throw new Error('The model service returned an unexpected vehicle list')
  return data
}

const loadIndex = async () => {
  if (cached && Date.now() - cached.loadedAt < REFRESH_AFTER_MS) return cached.index
  if (!isConfigured()) throw unavailable()
  loading ||= fetchIndex()
    .then(index => {
      cached = { index, loadedAt: Date.now() }
      return index
    })
    .finally(() => { loading = null })
  try {
    return await loading
  } catch {
    // A list that was fetched earlier is still correct while the model service restarts.
    if (cached) return cached.index
    throw unavailable()
  }
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
const catalogModelsFor = (make, model) => catalog.vehicles.filter(item => same(item.make, make) && (same(item.model, model) || item.datasetModels?.some(alias => same(alias, model))))

const displayModel = (make, model) => catalog.vehicles.find(item => same(item.make, make) && item.datasetModels?.some(alias => same(alias, model)))?.model || model
const values = (items = []) => items.map(item => item.value)

const optionsFrom = (index, { make = '', model = '', year = '' } = {}) => {
  const datasetMake = name => index.makes.find(item => same(item.make, name))
  const dataset = datasetMake(make)?.models.find(item => same(item.model, model))
  const catalogRecords = catalogModelsFor(make, model)
  const canonicalModel = displayModel(make, model)
  const selectedCatalog = findVehicle({ make, model: canonicalModel, year })
  const selectedDatasetYear = dataset?.years.find(item => Number(item.year) === Number(year))
  const catalogYears = catalogRecords.flatMap(item => item.years)
  const datasetYears = dataset?.years.map(item => item.year) || []
  const years = [...new Set([...catalogYears, ...datasetYears])].sort((a, b) => b - a)
  const verifiedVariants = selectedCatalog?.variants || []
  const source = selectedDatasetYear || { engines: [], transmissions: [], fuels: [], bodyTypes: [], assemblies: [] }
  return {
    version: index.version,
    makes: [...new Set([...index.makes.map(item => item.make), ...catalog.vehicles.map(item => item.make)])].sort(),
    models: !make ? [] : [...new Set([
      ...(datasetMake(make)?.models.map(item => displayModel(make, item.model)) || []),
      ...catalog.vehicles.filter(item => same(item.make, make)).map(item => item.model),
    ])].sort(),
    years,
    variants: verifiedVariants,
    engines: values(source.engines),
    transmissions: values(source.transmissions),
    fuels: values(source.fuels),
    bodyTypes: values(source.bodyTypes),
    assemblies: values(source.assemblies),
    coverageLevel: verifiedVariants.length ? 'verified' : (dataset ? 'dataset' : (catalogRecords.length ? 'partial' : 'unsupported')),
    supported: Boolean(dataset || catalogRecords.length),
    datasetModel: dataset?.model || null,
  }
}

const vehicleOptions = async (selection = {}) => optionsFrom(await loadIndex(), selection)

const validateDatasetConfiguration = async input => {
  const options = optionsFrom(await loadIndex(), { make: input.make, model: input.model, year: input.year })
  if (!options.supported) return { model: 'This make and model are not supported by the valuation dataset.' }
  if (!options.years.includes(Number(input.year))) return { year: 'This model year is not supported by the valuation dataset.' }
  if (options.coverageLevel === 'verified') return {}
  const errors = {}
  const verify = (field, valuesForField, value, label) => {
    if (valuesForField.length && value && !valuesForField.some(option => same(option, value))) errors[field] = `${label} is not supported for this vehicle year.`
  }
  if (options.engines.length && !options.engines.includes(Number(input.engineCapacity))) errors.engineCapacity = 'Engine capacity is not supported for this vehicle year.'
  verify('transmission', options.transmissions, input.transmission, 'Transmission')
  verify('fuelType', options.fuels, input.fuelType, 'Fuel type')
  verify('bodyType', options.bodyTypes, input.bodyType, 'Body type')
  verify('assemblyType', options.assemblies, input.assemblyType, 'Assembly type')
  return errors
}

module.exports = { vehicleOptions, validateDatasetConfiguration }
