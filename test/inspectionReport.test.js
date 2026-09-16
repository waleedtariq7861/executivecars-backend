const test = require('node:test')
const assert = require('node:assert/strict')
const Car = require('../src/models/Car')
const Product = require('../src/models/Product')
const { toInspectionSafeObject } = require('../src/utils/inspectionReport')

const auctionFields = {
  make: 'Toyota', model: 'Corolla', year: 2020, km: 45000, engine: '1800',
  basePrice: 5000000, auctionStart: new Date('2026-09-01T00:00:00Z'), auctionEnd: new Date('2026-09-02T00:00:00Z'),
}
const inspectionDocument = {
  provider: 'local', key: 'report.pdf', resourceType: 'raw', contentType: 'application/pdf', size: 64,
}

test('auction inspection status cannot claim an unavailable report', async () => {
  const car = new Car({ ...auctionFields, inspectionStatus: 'report_available', inspectionScore: 90 })
  await car.validate()
  assert.equal(car.inspectionStatus, 'not_available')
  assert.equal(car.inspectionScore, undefined)
})

test('an attached auction report derives report availability', async () => {
  const car = new Car({ ...auctionFields, inspectionStatus: 'not_available', inspectionDocument })
  await car.validate()
  assert.equal(car.inspectionStatus, 'report_available')
})

test('used-car inspection status follows the attached report', async () => {
  const withoutReport = new Product({ make: 'Honda', model: 'City', year: 2022, km: 30000, price: 5000000, inspectionStatus: 'report_available', inspectionScore: 88 })
  await withoutReport.validate()
  assert.equal(withoutReport.inspectionStatus, 'not_available')
  assert.equal(withoutReport.inspectionScore, undefined)

  const withReport = new Product({ make: 'Honda', model: 'City', year: 2022, km: 30000, price: 5000000, inspectionDocument })
  await withReport.validate()
  assert.equal(withReport.inspectionStatus, 'report_available')
})

test('public serialization normalizes contradictory legacy report metadata', () => {
  const legacy = toInspectionSafeObject({
    _id: 'legacy-record', inspectionStatus: 'report_available', inspectionScore: 88, pdfUrl: '',
  })
  assert.equal(legacy.hasInspectionReport, false)
  assert.equal(legacy.inspectionStatus, 'not_available')
  assert.equal(legacy.inspectionScore, undefined)

  const available = toInspectionSafeObject({
    _id: 'report-record', inspectionStatus: 'pending', inspectionDocument,
  }, { reportPath: '/documents/products/report-record/report' })
  assert.equal(available.hasInspectionReport, true)
  assert.equal(available.inspectionStatus, 'report_available')
  assert.equal(available.inspectionReportAccessPath, '/documents/products/report-record/report')
  assert.equal(available.inspectionDocument, undefined)

  const legacyUrl = toInspectionSafeObject({ inspectionStatus: 'report_available', pdfUrl: 'https://legacy.example/report.pdf' })
  assert.equal(legacyUrl.hasInspectionReport, false)
  assert.equal(legacyUrl.pdfUrl, undefined)
})
