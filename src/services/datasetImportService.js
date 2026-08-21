const crypto = require('crypto')

const aliases = {
  make: ['make', 'brand', 'manufacturer'],
  model: ['model', 'carmodel'],
  variant: ['variant', 'trim'],
  modelYear: ['modelyear', 'year'],
  registrationCity: ['registrationcity', 'registeredcity', 'registration'],
  listingCity: ['listingcity', 'city', 'location'],
  engineCapacity: ['enginecapacity', 'enginecc', 'engine', 'cc'],
  fuelType: ['fueltype', 'fuel'],
  transmission: ['transmission', 'gearbox'],
  mileage: ['mileage', 'km', 'kilometers', 'kilometres'],
  bodyType: ['bodytype', 'body'],
  assemblyType: ['assemblytype', 'assembly'],
  colour: ['colour', 'color'],
  condition: ['condition', 'vehiclecondition'],
  numberOfOwners: ['numberofowners', 'owners', 'ownercount'],
  inspectionScore: ['inspectionscore', 'score'],
  listingPrice: ['listingprice', 'price', 'askingprice'],
  finalSalePrice: ['finalsaleprice', 'saleprice', 'soldprice'],
  listingDate: ['listingdate', 'date', 'posteddate'],
  sourceUrl: ['sourceurl', 'url', 'listingurl'],
}

const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const text = value => String(value ?? '').trim().replace(/\s+/g, ' ')
const title = value => text(value).toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase())

const rowValue = (row, names) => {
  const normalized = Object.entries(row || {}).reduce((result, [field, value]) => ({ ...result, [key(field)]: value }), {})
  for (const name of names) if (normalized[name] !== undefined) return normalized[name]
  return undefined
}

const parseNumber = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = text(value).toLowerCase().replace(/pkr|rs\.?/g, '').replace(/,/g, '')
  if (!raw) return null
  const match = raw.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  let parsed = Number(match[0])
  if (/crore|\bcr\b/.test(raw)) parsed *= 10000000
  else if (/lakh|lac|\blacs?\b/.test(raw)) parsed *= 100000
  else if (/\bkm\b/.test(raw) && parsed < 1000 && /\dk\b/.test(raw)) parsed *= 1000
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeEnum = (value, mapping, fallback = '') => {
  const normalized = text(value).toLowerCase()
  return Object.entries(mapping).find(([, variants]) => variants.includes(normalized))?.[0] || (normalized ? title(normalized) : fallback)
}

const transmission = value => normalizeEnum(value, { Auto: ['auto', 'automatic', 'cvt', 'dct'], Manual: ['manual', 'mt'] })
const fuelType = value => normalizeEnum(value, { Petrol: ['petrol', 'gasoline'], Diesel: ['diesel'], CNG: ['cng'], Hybrid: ['hybrid', 'hev'], Electric: ['electric', 'ev'] })
const assemblyType = value => normalizeEnum(value, { Local: ['local', 'pakistan', 'ckd'], Imported: ['imported', 'import', 'cbu'], Unknown: ['unknown', 'n/a'] }, 'Unknown')
const condition = value => normalizeEnum(value, { Excellent: ['excellent', 'like new'], Good: ['good', 'used'], Fair: ['fair', 'average'], 'Needs Work': ['needs work', 'poor', 'damaged'], Unknown: ['unknown', 'n/a'] }, 'Unknown')

const parseCsv = input => {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (character === '"' && quoted && input[index + 1] === '"') { field += '"'; index += 1 }
    else if (character === '"') quoted = !quoted
    else if (character === ',' && !quoted) { row.push(field); field = '' }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && input[index + 1] === '\n') index += 1
      row.push(field); field = ''
      if (row.some(cell => cell.trim())) rows.push(row)
      row = []
    } else field += character
  }
  if (field || row.length) { row.push(field); if (row.some(cell => cell.trim())) rows.push(row) }
  if (rows.length < 2) return []
  const headers = rows[0].map(header => header.trim())
  return rows.slice(1).map(cells => headers.reduce((record, header, index) => ({ ...record, [header]: cells[index] ?? '' }), {}))
}

const parseDataset = file => {
  const content = file.buffer.toString('utf8').replace(/^\uFEFF/, '')
  if (/\.json$/i.test(file.originalname) || /json/i.test(file.mimetype)) {
    const parsed = JSON.parse(content)
    const records = Array.isArray(parsed) ? parsed : parsed.records
    if (!Array.isArray(records)) throw Object.assign(new Error('JSON must be an array or an object with a records array'), { status: 400 })
    return records
  }
  return parseCsv(content)
}

const normalizeRecord = (row, source) => {
  const value = field => rowValue(row, aliases[field])
  const modelYear = parseNumber(value('modelYear'))
  const mileage = parseNumber(value('mileage'))
  const listingPrice = parseNumber(value('listingPrice'))
  const finalSalePrice = parseNumber(value('finalSalePrice'))
  const record = {
    make: title(value('make')),
    model: title(value('model')),
    variant: title(value('variant')),
    modelYear: modelYear === null ? null : Math.round(modelYear),
    registrationCity: title(value('registrationCity')),
    listingCity: title(value('listingCity')),
    engineCapacity: parseNumber(value('engineCapacity')),
    fuelType: fuelType(value('fuelType')),
    transmission: transmission(value('transmission')),
    mileage: mileage === null ? null : Math.round(mileage),
    bodyType: title(value('bodyType')),
    assemblyType: assemblyType(value('assemblyType')),
    colour: title(value('colour')),
    condition: condition(value('condition')),
    numberOfOwners: parseNumber(value('numberOfOwners')),
    inspectionScore: parseNumber(value('inspectionScore')),
    listingPrice: listingPrice === null ? null : Math.round(listingPrice),
    finalSalePrice: finalSalePrice === null ? undefined : Math.round(finalSalePrice),
    listingDate: value('listingDate') ? new Date(value('listingDate')) : undefined,
    source: text(source),
    sourceUrl: /^https?:\/\//i.test(text(value('sourceUrl'))) ? text(value('sourceUrl')) : '',
  }
  if (record.listingDate && Number.isNaN(record.listingDate.getTime())) record.listingDate = undefined
  return record
}

const cleanDataset = (rows, source) => {
  const currentYear = new Date().getFullYear() + 1
  const accepted = []
  const seen = new Set()
  const report = { receivedRecords: rows.length, importedRecords: 0, rejectedRecords: 0, duplicateRecords: 0, usableRecords: 0, missingFields: {}, rejectionReasons: {} }
  const reject = reason => { report.rejectedRecords += 1; report.rejectionReasons[reason] = (report.rejectionReasons[reason] || 0) + 1 }

  rows.forEach(row => {
    const record = normalizeRecord(row, source)
    const missing = ['make', 'model', 'modelYear', 'mileage', 'listingPrice'].filter(field => record[field] === '' || record[field] === null)
    if (missing.length) {
      missing.forEach(field => { report.missingFields[field] = (report.missingFields[field] || 0) + 1 })
      reject('missing_required_fields')
      return
    }
    if (record.modelYear < 1980 || record.modelYear > currentYear) return reject('invalid_model_year')
    if (record.mileage < 0 || record.mileage > 1000000) return reject('unrealistic_mileage')
    if (record.listingPrice < 100000 || record.listingPrice > 500000000) return reject('unrealistic_price')
    if (record.engineCapacity !== null && (record.engineCapacity < 300 || record.engineCapacity > 10000)) return reject('invalid_engine_capacity')
    if (record.inspectionScore !== null && (record.inspectionScore < 0 || record.inspectionScore > 100)) return reject('invalid_inspection_score')

    const rawFingerprint = [record.make, record.model, record.variant, record.modelYear, record.mileage, record.listingPrice, record.listingCity, record.sourceUrl].join('|').toLowerCase()
    record.fingerprint = crypto.createHash('sha256').update(rawFingerprint).digest('hex')
    if (seen.has(record.fingerprint)) { report.duplicateRecords += 1; return }
    seen.add(record.fingerprint)
    accepted.push(record)
  })

  report.usableRecords = accepted.length
  return { records: accepted, report }
}

module.exports = { parseCsv, parseDataset, normalizeRecord, cleanDataset, parseNumber }
