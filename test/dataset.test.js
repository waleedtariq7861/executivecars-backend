const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseCsv, cleanDataset, parseNumber } = require('../src/services/datasetImportService')

test('localized Pakistani price values are parsed', () => {
  assert.equal(parseNumber('PKR 45 Lacs'), 4500000)
  assert.equal(parseNumber('1.2 Crore'), 12000000)
})

test('CSV parser handles quoted commas', () => {
  const rows = parseCsv('make,model,price,city\nToyota,"Corolla, Altis",4500000,Lahore\n')
  assert.equal(rows[0].model, 'Corolla, Altis')
})

test('cleaning reports invalid and duplicate records', () => {
  const valid = { make: 'Toyota', model: 'Corolla', year: 2020, mileage: 45000, price: 4500000, city: 'Lahore' }
  const { records, report } = cleanDataset([valid, valid, { make: 'Honda', model: 'City', year: 1970, mileage: 1, price: 3000000 }], 'Approved test data')
  assert.equal(records.length, 1)
  assert.equal(report.duplicateRecords, 1)
  assert.equal(report.rejectedRecords, 1)
  assert.equal(report.rejectionReasons.invalid_model_year, 1)
})
