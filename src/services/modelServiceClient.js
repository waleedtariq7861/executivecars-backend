// Where the valuation (model) service is and how to authenticate to it. Shared by every call to that service.

const isConfigured = () => Boolean(process.env.ML_API_URL || process.env.ML_SERVICE_URL)

const serviceBase = () => String(process.env.ML_SERVICE_URL || process.env.ML_API_URL || 'http://127.0.0.1:8000')
  .replace(/\/predict\/?$/, '')
  .replace(/\/$/, '')

const serviceHeaders = () => process.env.ML_SERVICE_KEY
  ? { 'X-Service-Key': process.env.ML_SERVICE_KEY }
  : undefined

module.exports = { isConfigured, serviceBase, serviceHeaders }
