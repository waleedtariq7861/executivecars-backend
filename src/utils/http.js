const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const badRequest = message => Object.assign(new Error(message), { status: 400 })

/**
 * A query-string value that must be one piece of text. Arrays and objects (the shape an operator-injection attempt
 * such as ?status[$ne]=x takes) are refused instead of being passed on to a database query.
 * Returns undefined for a missing or empty value.
 */
const queryText = (value, name = 'parameter') => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw badRequest(`${name} must be a single value`)
  return value.trim() || undefined
}

const oneOf = (value, allowedValues, name = 'parameter') => {
  const text = queryText(value, name)
  if (text !== undefined && !allowedValues.includes(text)) throw badRequest(`${name} must be one of: ${allowedValues.join(', ')}`)
  return text
}

/** Text from a request body that must be a string no longer than `max` characters. */
const boundedText = (value, max, name = 'value') => {
  const text = String(value ?? '').trim()
  if (text.length > max) throw badRequest(`${name} must be at most ${max} characters`)
  return text
}

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

module.exports = { escapeRegex, handleControllerError, pick, queryText, oneOf, boundedText, badRequest }
