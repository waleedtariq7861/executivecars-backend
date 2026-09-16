const axios = require('axios')
const VehicleRecord = require('../models/VehicleRecord')
const { handleControllerError } = require('../utils/http')

const serviceBase = () => String(process.env.ML_SERVICE_URL || process.env.ML_API_URL || 'http://127.0.0.1:8000/predict').replace(/\/predict\/?$/, '').replace(/\/$/, '')
const serviceConfig = (timeout = 5000) => ({ timeout, headers: process.env.ML_SERVICE_KEY ? { 'X-Service-Key': process.env.ML_SERVICE_KEY } : undefined })

const predictionServiceHealth = async (req, res) => {
  try {
    const { data } = await axios.get(`${serviceBase()}/health`, serviceConfig(3000))
    res.json({ reachable: true, ...data })
  } catch (error) {
    res.json({ reachable: false, status: 'unavailable', message: 'Prediction service is not reachable. Comparable-listing fallback remains available.' })
  }
}

const getModelVersions = async (req, res) => {
  try {
    const { data } = await axios.get(`${serviceBase()}/models`, serviceConfig())
    res.json(data)
  } catch (error) {
    error.status = error.response?.status === 401 ? 502 : 503
    handleControllerError(res, error, 'Could not load model versions')
  }
}

const trainModel = async (req, res) => {
  try {
    const [records, sourceCounts] = await Promise.all([
      VehicleRecord.find().select('-_id -__v -fingerprint -importBatchId -createdAt -updatedAt').lean(),
      VehicleRecord.aggregate([{ $group: { _id: '$source', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    ])
    if (records.length < 30) return res.status(400).json({ message: `At least 30 usable dataset rows are required. Current total: ${records.length}` })
    const provenance = {
      datasetName: 'Administrator-imported MongoDB training records',
      sourceCategory: 'Rights-confirmed administrator imports',
      sources: sourceCounts.map(item => ({ source: item._id, rows: item.count })),
    }
    const { data } = await axios.post(`${serviceBase()}/train`, { records, provenance }, serviceConfig(10 * 60 * 1000))
    res.status(201).json(data)
  } catch (error) {
    const message = error.response?.data?.detail || error.message
    error.message = message
    error.status = error.response?.status === 400 ? 400 : 503
    handleControllerError(res, error, 'Model training service is unavailable')
  }
}

const activateModelVersion = async (req, res) => {
  try {
    const { data } = await axios.post(`${serviceBase()}/models/${encodeURIComponent(req.params.version)}/activate`, {}, serviceConfig())
    res.json(data)
  } catch (error) {
    error.message = error.response?.data?.detail || error.message
    error.status = error.response?.status === 404 ? 404 : 503
    handleControllerError(res, error, 'Could not activate model version')
  }
}

const rollbackModelVersion = async (req, res) => {
  try {
    const { data } = await axios.post(`${serviceBase()}/models/rollback`, {}, serviceConfig())
    res.json(data)
  } catch (error) {
    error.message = error.response?.data?.detail || error.message
    error.status = error.response?.status === 409 ? 409 : 503
    handleControllerError(res, error, 'Could not roll back model version')
  }
}

module.exports = { predictionServiceHealth, getModelVersions, trainModel, activateModelVersion, rollbackModelVersion }
