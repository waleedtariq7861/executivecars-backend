const { after, afterEach, beforeEach, describe, mock, test } = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const request = require('supertest')
const { startFakeModelService, freshVehicleOptions } = require('./helpers/fakeModelService')

const KEY = 'test-service-key-0123456789'
let modelService
let loaded

const useModelService = async ({ key = '' } = {}) => {
  modelService = await startFakeModelService({ key })
  process.env.ML_API_URL = ''
  process.env.ML_SERVICE_URL = modelService.url
  process.env.ML_SERVICE_KEY = KEY
  loaded = freshVehicleOptions()
}

const appWith = ({ optionsRouter, predictRouter }) => {
  const app = express()
  app.use(express.json())
  app.use('/api/vehicle-options', optionsRouter)
  app.use('/api/predict', predictRouter)
  app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message }))
  return app
}

afterEach(async () => {
  mock.restoreAll()
  await modelService?.close()
  modelService = null
})
after(() => {
  delete process.env.ML_SERVICE_URL
  delete process.env.ML_SERVICE_KEY
})

describe('the vehicle list comes from the model service', () => {
  beforeEach(() => useModelService())

  test('is fetched with the service key and only once for many requests', async () => {
    await Promise.all([loaded.service.vehicleOptions(), loaded.service.vehicleOptions({ make: 'Hyundai' })])
    await loaded.service.vehicleOptions({ make: 'Honda' })
    assert.deepEqual(modelService.requests, [{ url: '/vehicle-options', key: KEY }])
  })

  test('is fetched again after an hour, and the earlier list is kept if the service is down by then', async () => {
    await loaded.service.vehicleOptions()
    const now = Date.now()
    mock.method(Date, 'now', () => now + 2 * 60 * 60 * 1000)
    await loaded.service.vehicleOptions()
    assert.equal(modelService.requests.length, 2)

    mock.method(Date, 'now', () => now + 4 * 60 * 60 * 1000)
    modelService.fail()
    const options = await loaded.service.vehicleOptions({ make: 'Hyundai' })
    assert.equal(modelService.requests.length, 3)
    assert.ok(options.makes.includes('Hyundai'))
  })

  test('is refused with 503 when the service is down and nothing was fetched yet', async () => {
    modelService.fail()
    await assert.rejects(loaded.service.vehicleOptions(), error => error.status === 503 && /temporarily unavailable/.test(error.message))
    modelService.fail(false)
    assert.ok((await loaded.service.vehicleOptions()).makes.includes('Toyota'), 'a failed fetch is not remembered')
  })

  test('is refused with 503 when the service answers with something that is not a vehicle list', async () => {
    modelService.answerWith({ detail: 'not a list' })
    await assert.rejects(loaded.service.vehicleOptions(), error => error.status === 503)
    modelService.answerWith(undefined)
    await assert.rejects(loaded.service.vehicleOptions(), error => error.status === 503)
  })

  test('is refused with 503 when the service rejects the key', async () => {
    await modelService.close()
    modelService = await startFakeModelService({ key: 'a-different-key' })
    process.env.ML_SERVICE_URL = modelService.url
    loaded = freshVehicleOptions()
    await assert.rejects(loaded.service.vehicleOptions(), error => error.status === 503)
    assert.equal(modelService.requests[0].key, KEY)
  })

  test('is refused with 503 when no model service is configured', async () => {
    process.env.ML_SERVICE_URL = ''
    process.env.ML_API_URL = ''
    loaded = freshVehicleOptions()
    await assert.rejects(loaded.service.vehicleOptions(), error => error.status === 503)
    assert.equal(modelService.requests.length, 0)
  })

  test('over HTTP: GET /api/vehicle-options answers from the list, and 503 when it cannot be had', async () => {
    const app = appWith(loaded)
    const response = await request(app).get('/api/vehicle-options').query({ make: 'Honda', model: 'Civic', year: 2020 })
    assert.equal(response.status, 200)
    assert.ok(response.body.models.includes('Civic'))
    assert.equal(response.body.supported, true)

    process.env.ML_SERVICE_URL = ''
    loaded = freshVehicleOptions()
    const down = await request(appWith(loaded)).get('/api/vehicle-options')
    assert.equal(down.status, 503)
  })

  test('over HTTP: a valuation for a vehicle the model never saw is rejected before the model is asked', async () => {
    const app = appWith(loaded)
    const unsupported = await request(app).post('/api/predict').send({ make: 'Example Motors', model: 'Imaginary', year: 2021, mileage: 30000, engineCapacity: 1300 })
    assert.equal(unsupported.status, 400)
    assert.ok(unsupported.body.errors.model)

    process.env.ML_SERVICE_URL = ''
    loaded = freshVehicleOptions()
    const unavailable = await request(appWith(loaded)).post('/api/predict').send({ make: 'Example Motors', model: 'Imaginary', year: 2021, mileage: 30000, engineCapacity: 1300 })
    assert.equal(unavailable.status, 503)
  })
})
