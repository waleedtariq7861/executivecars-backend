process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'smtp'
const { DEFAULT_TEST_URI, validateTestUri, connectTestDatabase, dropTestDatabase, resetTestDatabase } = require('./helpers/localDatabase')
process.env.MONGO_URI = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GROQ_API_KEY', 'ML_SERVICE_KEY', 'RESEND_API_KEY']) process.env[key] = ''

const { before, after, beforeEach, afterEach, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const mongoose = require('mongoose')
require('./helpers/noRateLimits')
const request = require('supertest')
require('./helpers/cookieAuth')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const Bid = require('../src/models/Bid')
const Booking = require('../src/models/Booking')
const Car = require('../src/models/Car')
const Member = require('../src/models/Member')
const Payment = require('../src/models/Payment')
const Product = require('../src/models/Product')
const { deletePrivateAsset, privateUploadDir } = require('../src/config/cloudinary')
const { CONFIRMATION, planCatalog, seedCatalog } = require('../scripts/seedCatalog')
const { findings, OK, MINOR, ATTENTION } = require('../scripts/lib/sampleInspectionReport')

const NOW = new Date('2026-11-03T08:00:00Z')
const DAY = 86_400_000

before(async () => { await connectTestDatabase() })
after(async () => {
  if (mongoose.connection.readyState === 1) {
    try { await dropTestDatabase() } finally { await mongoose.disconnect() }
  }
})
beforeEach(async () => { await resetTestDatabase() })

// Reports written to the private folder by a test are removed again, so a run leaves no files behind.
afterEach(async () => {
  for (const record of [...await Product.find().lean(), ...await Car.find().lean()]) await deletePrivateAsset(record.inspectionDocument)
})
const reportFiles = () => (fs.existsSync(privateUploadDir) ? fs.readdirSync(privateUploadDir).sort() : [])
const asBearer = token => ({ Authorization: `Bearer ${token}` })

// The text of an uncompressed PDF written by pdfkit: every shown string is a hex string inside a TJ array (one per line).
const pdfText = bytes => [...bytes.toString('latin1').matchAll(/\[([^\]]*)\] TJ/g)]
  .map(([, parts]) => [...parts.matchAll(/<([0-9a-f]*)>/gi)].map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1')).join(''))
  .join(' ')

// Compression is off so the text inside the PDF can be read back.
const run = (options = {}) => seedCatalog({ now: NOW, execute: true, confirmation: CONFIRMATION, compress: false, ...options })

describe('the platform catalogue seed', () => {
  test('writes only used cars and auctions (with their reports), and nothing else', async () => {
    const result = await run()
    assert.deepEqual(result, { executed: true, products: 4, auctions: 2, reports: 6 })
    assert.equal(await Product.countDocuments(), 4)
    assert.equal(await Car.countDocuments(), 2)
    const others = await Promise.all([Admin, Member, Bid, Booking, Payment].map(Model => Model.countDocuments()))
    assert.deepEqual(others, [0, 0, 0, 0, 0])
  })

  test('every listing belongs to the platform: no owner and no seller e-mail', async () => {
    await run()
    for (const record of [...await Product.find().lean(), ...await Car.find().lean()]) {
      assert.equal(record.ownerId, undefined, `${record.make} ${record.model} has an owner`)
      assert.equal(record.sellerEmail, undefined)
    }
  })

  test('the used cars are used, available and priced, each with one hosted photo and its credit', async () => {
    await run()
    const products = await Product.find().lean()
    assert.deepEqual(products.map(item => item.model).sort(), ['City', 'Sportage', 'Swift', 'Yaris'])
    for (const item of products) {
      assert.equal(item.listingType, 'used')
      assert.equal(item.status, 'available')
      assert.ok(item.price > 0 && item.km >= 0)
      assert.equal(item.images.length, 1)
      assert.match(item.images[0], /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/.+\.jpg$/)
      assert.match(item.description, /Photo: .+;.+\. Source: https:\/\/commons\.wikimedia\.org\//s, 'photo credit kept')
      assert.equal(item.key, undefined, 'planning fields are not stored')
    }
  })

  test('one auction is running and one is upcoming, with no bids and a base price as the current bid', async () => {
    await run()
    const cars = await Car.find().lean()
    const byModel = Object.fromEntries(cars.map(item => [item.model, item]))
    const civic = byModel.Civic
    const fortuner = byModel.Fortuner
    assert.ok(civic.auctionStart < NOW && civic.auctionEnd > new Date(NOW.getTime() + 7 * DAY), 'the live auction has a week or more left')
    assert.ok(fortuner.auctionStart > NOW && fortuner.auctionEnd > fortuner.auctionStart, 'the other auction has not started')
    for (const car of cars) {
      assert.equal(car.status, 'active')
      assert.equal(car.bidCount, 0)
      assert.equal(car.highestBidder, undefined)
      assert.equal(car.currentBid, car.basePrice)
      assert.ok(car.reservePrice > car.basePrice)
      assert.equal(car.images.length, 1)
      assert.equal(car.key, undefined)
    }
  })

  test('the planned dates follow the day it is run', () => {
    const later = planCatalog(new Date(NOW.getTime() + 10 * DAY))
    const earlier = planCatalog(NOW)
    assert.equal(later.auctions[0].fields.auctionStart - earlier.auctions[0].fields.auctionStart, 10 * DAY)
  })

  test('shows the plan and writes nothing unless asked to', async () => {
    const filesBefore = reportFiles()
    const result = await seedCatalog({ now: NOW })
    assert.equal(result.executed, false)
    assert.equal(result.plan.products.length, 4)
    assert.equal(result.reportBytes.length, 6)
    assert.equal(await Product.countDocuments(), 0)
    assert.equal(await Car.countDocuments(), 0)
    assert.deepEqual(reportFiles(), filesBefore, 'no report file is stored')
  })

  test('refuses to write without the exact confirmation word', async () => {
    const filesBefore = reportFiles()
    for (const confirmation of [undefined, '', 'yes', CONFIRMATION.toUpperCase()]) {
      await assert.rejects(seedCatalog({ now: NOW, execute: true, confirmation }), /CONFIRM_CATALOG_SEED/)
    }
    assert.equal(await Product.countDocuments() + await Car.countDocuments(), 0)
    assert.deepEqual(reportFiles(), filesBefore)
  })

  test('refuses to run when any used car or auction already exists, leaving it untouched', async () => {
    const existing = await Product.create({ make: 'Honda', model: 'Civic', year: 2019, km: 1000, price: 1 })
    await assert.rejects(run(), /already holds/)
    assert.equal(await Product.countDocuments(), 1)
    assert.equal(await Car.countDocuments(), 0)
    assert.equal((await Product.findById(existing._id)).price, 1)

    await resetTestDatabase()
    await Car.create({ make: 'Honda', model: 'Civic', year: 2019, km: 1000, engine: '1800', basePrice: 1, auctionStart: NOW, auctionEnd: new Date(NOW.getTime() + DAY) })
    await assert.rejects(run(), /already holds/)
    assert.equal(await Product.countDocuments(), 0)
  })

  test('running it twice does not duplicate anything', async () => {
    await run()
    const filesBefore = reportFiles()
    await assert.rejects(run(), /already holds/)
    assert.equal(await Product.countDocuments(), 4)
    assert.equal(await Car.countDocuments(), 2)
    assert.deepEqual(reportFiles(), filesBefore, 'the second run stores nothing')
  })

  test('is all-or-nothing: an invalid auction leaves no listing and no stored report behind', async () => {
    const filesBefore = reportFiles()
    const catalogModule = require('../scripts/data/platformCatalog.json')
    const original = catalogModule.auctions[1].endsInDays
    catalogModule.auctions[1].endsInDays = catalogModule.auctions[1].startsInDays
    try {
      await assert.rejects(run(), /end time/i)
    } finally {
      catalogModule.auctions[1].endsInDays = original
    }
    assert.equal(await Product.countDocuments(), 0)
    assert.equal(await Car.countDocuments(), 0)
    assert.deepEqual(reportFiles(), filesBefore, 'the reports stored before the failure are removed again')
  })

  test('the public used-car list shows the seeded cars, without owner or seller details', async () => {
    await run()
    const response = await request(createApp()).get('/api/products')
    assert.equal(response.status, 200)
    const list = Array.isArray(response.body) ? response.body : response.body.products
    assert.equal(list.length, 4)
    const text = JSON.stringify(list)
    assert.ok(!/ownerId|sellerEmail/.test(text))
    assert.ok(list.every(item => item.images[0].startsWith('https://res.cloudinary.com/')))
  })
})

describe('the sample inspection reports', () => {
  test('every used car and auction has one, as a stored PDF that says it is a sample', async () => {
    await run()
    const records = [...await Product.find().lean(), ...await Car.find().lean()]
    assert.equal(records.length, 6)
    const keys = new Set()
    for (const record of records) {
      const asset = record.inspectionDocument
      assert.equal(record.inspectionStatus, 'report_available')
      assert.equal(record.inspectionScore, undefined, 'no inspection score is claimed for a vehicle nobody inspected')
      assert.equal(asset.contentType, 'application/pdf')
      assert.equal(asset.extension, '.pdf')
      assert.equal(asset.provider, 'local')
      assert.equal(asset.resourceType, 'raw')
      keys.add(asset.key)
      const bytes = fs.readFileSync(`${privateUploadDir}/${asset.key}`)
      assert.equal(bytes.length, asset.size)
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
      assert.match(bytes.subarray(-8).toString(), /%%EOF/)
      const pages = bytes.toString('latin1').match(/\/Type \/Page\n/g)?.length
      assert.ok(pages >= 1 && pages <= 3, `a report is two or three pages, not ${pages}`)
      const text = pdfText(bytes)
      assert.match(text, /SAMPLE REPORT FOR DEMONSTRATION/)
      assert.match(text, /was not physically inspected/)
      assert.match(text, /SAMPLE: not a real inspection\. EC-SAMPLE-/)
      assert.match(text, /Odometer reading As listed, not verified/)
      assert.match(text, /Accident, flood and tampering history Not checked/)
      assert.match(text, /Registration and ownership documents Not checked/)
      assert.ok(text.includes(record.model), `the report names the ${record.model}`)
    }
    assert.equal(keys.size, 6, 'each listing has its own file')
  })

  test('in production it refuses to keep reports on a local disk, and leaves nothing behind', async () => {
    const filesBefore = reportFiles()
    process.env.NODE_ENV = 'production'
    try {
      await assert.rejects(run(), /Cloudinary credentials are missing/)
    } finally {
      process.env.NODE_ENV = 'test'
    }
    assert.equal(await Product.countDocuments() + await Car.countDocuments(), 0)
    assert.deepEqual(reportFiles(), filesBefore)
  })

  test('the findings follow the stated condition and claim nothing that was not checked', () => {
    const results = condition => findings({ condition }).flatMap(([, items]) => items.map(([, result]) => result))
    const count = (list, value) => list.filter(item => item === value).length
    assert.equal(count(results('Excellent'), MINOR) + count(results('Excellent'), ATTENTION), 1)
    assert.equal(count(results('Good'), MINOR), 3)
    assert.equal(count(results('Fair'), ATTENTION), 2)
    assert.ok(count(results('Fair'), OK) < count(results('Excellent'), OK))
  })

  test('members open the report through the authorised routes and get the stored PDF', async () => {
    await run()
    const app = createApp()
    const registration = await request(app).post('/api/auth/register').send({ name: 'Report Reader', email: 'report-reader@example.com', phone: '+92 300 5550888', password: 'orchid-lantern-77' })
    const token = registration.body.token
    const product = await Product.findOne({ model: 'Swift' })
    assert.equal((await request(app).get(`/api/documents/products/${product._id}/report`)).status, 401, 'signed-out visitors cannot')

    const access = await request(app).get(`/api/documents/products/${product._id}/report`).set(asBearer(token))
    assert.equal(access.status, 200)
    const download = await request(app).get(new URL(access.body.url).pathname).buffer(true).parse((res, done) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => done(null, Buffer.concat(chunks)))
    })
    assert.equal(download.status, 200)
    assert.equal(download.body.subarray(0, 5).toString(), '%PDF-')
    assert.match(pdfText(download.body), /2022 Suzuki Swift GL CVT/)

    const auction = await Car.findOne({ model: 'Civic' })
    assert.equal((await request(app).get(`/api/documents/auctions/${auction._id}/report`).set(asBearer(token))).status, 403, 'an auction report still needs an active membership')
  })

  test('the public list says a report exists but never reveals where it is stored', async () => {
    await run()
    const response = await request(createApp()).get('/api/products')
    const list = Array.isArray(response.body) ? response.body : response.body.products
    assert.ok(list.every(item => item.hasInspectionReport === true && item.inspectionStatus === 'report_available'))
    assert.ok(!JSON.stringify(list).includes('inspectionDocument'))
  })
})
