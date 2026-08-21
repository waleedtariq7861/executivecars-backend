const PERSON_NAME_PATTERN = /^[\p{L}\p{M}]+(?:[ .'-][\p{L}\p{M}]+)*$/u
const PHONE_PATTERN = /^\+?\d{10,15}$/
const CNIC_PATTERN = /^\d{5}-\d{7}-\d$/

const normalizePersonName = value => String(value ?? '').trim().replace(/\s+/g, ' ')

const isValidPersonName = value => {
  const normalized = normalizePersonName(value)
  return normalized.length >= 2
    && normalized.length <= 80
    && PERSON_NAME_PATTERN.test(normalized)
}

const normalizePhone = value => String(value ?? '')
  .trim()
  .replace(/[\s()-]/g, '')

const isValidPhone = value => PHONE_PATTERN.test(normalizePhone(value))

const normalizeCnic = value => {
  const normalized = String(value ?? '').trim()
  if (/^\d{13}$/.test(normalized)) {
    return `${normalized.slice(0, 5)}-${normalized.slice(5, 12)}-${normalized.slice(12)}`
  }
  return normalized
}

const isValidCnic = value => CNIC_PATTERN.test(normalizeCnic(value))

const strictNumber = (name, value, {
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  integer = false,
} = {}) => {
  const pattern = integer ? /^\d+$/ : /^\d+(?:\.\d+)?$/
  const validSyntax = typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string' && pattern.test(value.trim())
  const parsed = validSyntax ? Number(value) : Number.NaN

  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min || parsed > max) {
    const range = Number.isFinite(min) && Number.isFinite(max)
      ? ` between ${min} and ${max}`
      : Number.isFinite(min)
        ? ` of at least ${min}`
        : Number.isFinite(max)
          ? ` no greater than ${max}`
          : ''
    const error = new Error(`${name} must be ${integer ? 'a whole number' : 'a valid number'}${range}`)
    error.status = 400
    throw error
  }
  return parsed
}

const validateProfileInput = (payload, { requireName = false, requirePhone = false } = {}) => {
  const updates = {}
  const errors = {}

  if (payload.name !== undefined || requireName) {
    updates.name = normalizePersonName(payload.name)
    if (!isValidPersonName(updates.name)) errors.name = 'Name must contain letters only and be between 2 and 80 characters.'
  }

  if (payload.phone !== undefined || requirePhone) {
    updates.phone = normalizePhone(payload.phone)
    if ((updates.phone || requirePhone) && !isValidPhone(updates.phone)) errors.phone = 'Phone must contain 10 to 15 digits with an optional leading +.'
  }

  if (payload.cnic !== undefined) {
    updates.cnic = normalizeCnic(payload.cnic)
    if (updates.cnic && !isValidCnic(updates.cnic)) errors.cnic = 'CNIC must contain exactly 13 digits in XXXXX-XXXXXXX-X format.'
  }

  return { updates, errors }
}

module.exports = {
  PERSON_NAME_PATTERN,
  PHONE_PATTERN,
  CNIC_PATTERN,
  normalizePersonName,
  isValidPersonName,
  normalizePhone,
  isValidPhone,
  normalizeCnic,
  isValidCnic,
  strictNumber,
  validateProfileInput,
}
