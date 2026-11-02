// A real HTTP server that answers like the valuation (model) service does for the vehicle list.
// Tests point ML_SERVICE_URL at it, so the request, the service key and the failure handling are exercised for real.
const http = require('node:http')
const fixture = require('../fixtures/vehicleOptions.json')

const startFakeModelService = async ({ key = '' } = {}) => {
  const requests = []
  let failing = false
  let body = fixture
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, key: req.headers['x-service-key'] })
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (failing) return reply(500, { detail: 'broken' })
    if (key && req.headers['x-service-key'] !== key) return reply(401, { detail: 'Invalid service key' })
    if (req.url === '/vehicle-options') return reply(200, body)
    return reply(404, { detail: 'Not Found' })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    fail: (value = true) => { failing = value },
    answerWith: value => { body = value },
    close: () => new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    }),
  }
}

// The vehicle list is kept in memory by the service module. A test that needs a clean start loads fresh copies of
// the service and of the routes that use it.
const freshVehicleOptions = () => {
  for (const name of ['../../src/services/vehicleOptionsService', '../../src/routes/vehicleOptions', '../../src/routes/predict']) {
    delete require.cache[require.resolve(name)]
  }
  return {
    service: require('../../src/services/vehicleOptionsService'),
    optionsRouter: require('../../src/routes/vehicleOptions'),
    predictRouter: require('../../src/routes/predict'),
  }
}

module.exports = { startFakeModelService, freshVehicleOptions }
