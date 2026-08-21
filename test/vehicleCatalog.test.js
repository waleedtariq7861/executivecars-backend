const test = require('node:test')
const assert = require('node:assert/strict')
const { catalog, normalizeForMl, specification, validateConfiguration } = require('../src/data/vehicleCatalog')
const { validateDatasetConfiguration, vehicleOptions } = require('../src/services/vehicleOptionsService')

const base = {
  make: 'Suzuki', model: 'Cultus', year: 2021, variant: 'VXR', engineCapacity: 998,
  transmission: 'Manual', fuelType: 'Petrol', bodyType: 'Hatchback', assemblyType: 'Local',
}

test('contains the reviewed Cultus variants and derives their specifications', () => {
  assert.equal(catalog.version, 3)
  assert.deepEqual(specification(base).transmissions, ['Manual'])
  assert.equal(specification({ ...base, variant: 'VXL' }).name, 'VXL')
  assert.deepEqual(specification({ ...base, variant: 'VXL AGS', transmission: 'Auto' }).transmissions, ['Auto'])
})

test('uses separate generation records for high-volume Toyota and Honda models', () => {
  assert.equal(specification({ make: 'Toyota', model: 'Corolla', year: 2014, variant: 'XLi 1.3 MT' }).engineCapacity, 1298)
  assert.equal(specification({ make: 'Toyota', model: 'Corolla', year: 2021, variant: '1.8 Grande Gasoline' }).bodyType, 'Sedan')
  assert.equal(specification({ make: 'Honda', model: 'Civic', year: 2020, variant: 'RS Turbo 1.5' }).engineCapacity, 1498)
  assert.equal(specification({ make: 'Honda', model: 'City', year: 2018, variant: 'Aspire Prosmatec 1.5 i-VTEC' }).transmissions[0], 'Auto')
})

test('rejects cross-generation and impossible Toyota or Honda configurations', () => {
  const corolla = { make: 'Toyota', model: 'Corolla', year: 2014, variant: 'XLi 1.3 MT', engineCapacity: 1298, transmission: 'Manual', fuelType: 'Petrol', bodyType: 'Sedan', assemblyType: 'Local' }
  assert.ok(validateConfiguration({ ...corolla, engineCapacity: 1800 }).engineCapacity)
  assert.ok(validateConfiguration({ ...corolla, variant: '1.8 Grande Gasoline' }).variant)
  const civic = { make: 'Honda', model: 'Civic', year: 2020, variant: 'RS Turbo 1.5', engineCapacity: 1498, transmission: 'Auto', fuelType: 'Petrol', bodyType: 'Sedan', assemblyType: 'Local' }
  assert.ok(validateConfiguration({ ...civic, transmission: 'Manual' }).transmission)
})

test('preserves catalog terminology while adapting known ML labels', () => {
  assert.equal(normalizeForMl({ make: 'Suzuki', model: 'Wagon R', year: 2022 }).model, 'Wagon')
})

test('merges dataset coverage with verified catalog coverage without hiding Hyundai', () => {
  const root = vehicleOptions()
  assert.ok(root.makes.includes('Hyundai'))
  const hyundai = vehicleOptions({ make: 'Hyundai' })
  assert.ok(hyundai.models.includes('Tucson'))
  const tucson = vehicleOptions({ make: 'Hyundai', model: 'Tucson', year: 2021 })
  assert.equal(tucson.coverageLevel, 'dataset')
  assert.equal(tucson.variants.length, 0)
  assert.ok(tucson.engines.length)
  const manualVariantInput = { make: 'Hyundai', model: 'Tucson', year: 2021, variant: 'GL', engineCapacity: tucson.engines[0], transmission: tucson.transmissions[0], fuelType: tucson.fuels[0], bodyType: tucson.bodyTypes[0], assemblyType: tucson.assemblies[0] }
  assert.deepEqual(validateConfiguration(manualVariantInput), {})
  assert.deepEqual(validateDatasetConfiguration(manualVariantInput), {})
})

test('rejects a vehicle absent from both the trained-data index and verified catalog', () => {
  const errors = validateDatasetConfiguration({ make: 'Example Motors', model: 'Imaginary', year: 2021 })
  assert.ok(errors.model)
})

test('rejects impossible verified Cultus configurations before ML prediction', () => {
  assert.ok(validateConfiguration({ ...base, engineCapacity: 1800 }).engineCapacity)
  assert.ok(validateConfiguration({ ...base, fuelType: 'Diesel' }).fuelType)
  assert.ok(validateConfiguration({ ...base, variant: 'VXL AGS', transmission: 'Manual' }).transmission)
  assert.ok(validateConfiguration({ ...base, variant: 'GLX CVT' }).variant)
  assert.deepEqual(validateConfiguration({ ...base, year: 2017, variant: 'VXL' }), {})
})
