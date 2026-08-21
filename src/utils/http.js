const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const handleControllerError = (res, error, fallback = 'Request failed') => {
  if (error?.code === 11000) {
    return res.status(409).json({ message: 'A record with these details already exists' })
  }
  if (error?.name === 'CastError') {
    return res.status(400).json({ message: 'Invalid record identifier' })
  }
  if (error?.name === 'ValidationError') {
    const message = Object.values(error.errors || {})[0]?.message || 'Validation failed'
    return res.status(400).json({ message })
  }
  return res.status(error?.status || 500).json({
    message: error?.status ? error.message : (process.env.NODE_ENV === 'production' ? fallback : error?.message || fallback),
  })
}

const pick = (source, fields) => fields.reduce((result, field) => {
  if (Object.prototype.hasOwnProperty.call(source || {}, field)) result[field] = source[field]
  return result
}, {})

module.exports = { escapeRegex, handleControllerError, pick }
