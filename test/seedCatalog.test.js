process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'smtp'
const { DEFAULT_TEST_URI, validateTestUri, connectTestDatabase, dropTestDatabase, resetTestDatabase } = require('./helpers/localDatabase')
process.env.MONGO_URI = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GROQ_API_KEY', 'ML_SERVICE_KEY', 'RESEND_API_KEY']) process.env[key] = ''

const { before, after, beforeEach, afterEach, describe, mock, test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
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
const { deletePrivateAsset, privateUploadDir, publicImageDir } = require('../src/config/cloudinary')
const { CONFIRMATION, downloadPhoto, planCatalog, seedCatalog } = require('../scripts/seedCatalog')
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

const imageFileOf = url => path.join(publicImageDir, decodeURIComponent(String(url).replace('/uploads/images/', '')))

// Files written by a test are removed again, so a run leaves nothing behind.
afterEach(async () => {
  for (const record of [...await Product.find().lean(), ...await Car.find().lean()]) {
    await deletePrivateAsset(record.inspectionDocument)
    for (const image of record.images || []) if (image.startsWith('/uploads/images/')) fs.rmSync(imageFileOf(image), { force: true })
  }
})
const list = folder => (fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [])
const storedFiles = () => ({ reports: list(privateUploadDir), images: list(publicImageDir) })
const asBearer = token => ({ Authorization: `Bearer ${token}` })

// The text of an uncompressed PDF written by pdfkit: every shown string is a hex string inside a TJ array (one per line).
const pdfText = bytes => [...bytes.toString('latin1').matchAll(/\[([^\]]*)\] TJ/g)]
  .map(([, parts]) => [...parts.matchAll(/<([0-9a-f]*)>/gi)].map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1')).join(''))
  .join(' ')

// A stand-in for the download: a small file that starts like a JPEG, one per photograph.
const fakePhoto = photo => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`fake photograph of ${photo.source}`)])
const fetched = []
const fetchPhoto = async photo => { fetched.push(photo.source); return fakePhoto(photo) }

// Compression is off so the text inside the PDF can be read back.
const run = (options = {}) => seedCatalog({ now: NOW, execute: true, confirmation: CONFIRMATION, compress: false, fetchPhoto, ...options })

describe('the platform catalogue seed', () => {
  beforeEach(() => { fetched.length = 0 })

  test('writes only used cars and auctions (with photos and reports), and nothing else', async () => {
    const result = await run()
    assert.deepEqual(result, { executed: true, products: 4, auctions: 2, photos: 6, reports: 6 })
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

  test('the used cars are used, available and priced, each with its own stored photo and the photo credit', async () => {
    await run()
    const products = await Product.find().lean()
    assert.deepEqual(products.map(item => item.model).sort(), ['City', 'Sportage', 'Swift', 'Yaris'])
    const urls = new Set()
    for (const item of products) {
      assert.equal(item.listingType, 'used')
      assert.equal(item.status, 'available')
      assert.ok(item.price > 0 && item.km >= 0)
      assert.equal(item.images.length, 1)
      assert.match(item.images[0], /^\/uploads\/images\/[0-9]+-[0-9a-f]{32}\.jpg$/)
      assert.equal(fs.readFileSync(imageFileOf(item.images[0])).subarray(0, 3).toString('hex'), 'ffd8ff', 'the stored file is the downloaded photo')
      urls.add(item.images[0])
      assert.match(item.description, /Photo: .+;.+\. Source: https:\/\/commons\.wikimedia\.org\//s, 'photo credit kept')
      assert.equal(item.key, undefined, 'planning fields are not stored')
      assert.equal(item.photo, undefined)
    }
    assert.equal(urls.size, 4)
  })

  test('each photograph is fetched once, from its pinned Wikimedia original', async () => {
    await run()
    const sources = planCatalog(NOW)
    const expected = [...sources.products, ...sources.auctions].map(item => item.photo.source)
    assert.deepEqual(fetched, expected)
    assert.ok(expected.every(source => source.startsWith('https://upload.wikimedia.org/')))
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

  test('shows the plan and writes nothing, downloads nothing, unless asked to', async () => {
    const filesBefore = storedFiles()
    const result = await seedCatalog({ now: NOW, fetchPhoto })
    assert.equal(result.executed, false)
    assert.equal(result.plan.products.length, 4)
    assert.equal(result.reportBytes.length, 6)
    assert.equal(await Product.countDocuments(), 0)
    assert.equal(await Car.countDocuments(), 0)
    assert.deepEqual(storedFiles(), filesBefore, 'no file is stored')
    assert.deepEqual(fetched, [], 'no photograph is downloaded')
  })

  test('refuses to write without the exact confirmation word, before downloading anything', async () => {
    const filesBefore = storedFiles()
    for (const confirmation of [undefined, '', 'yes', CONFIRMATION.toUpperCase()]) {
      await assert.rejects(seedCatalog({ now: NOW, execute: true, confirmation, fetchPhoto }), /CONFIRM_CATALOG_SEED/)
    }
    assert.equal(await Product.countDocuments() + await Car.countDocuments(), 0)
    assert.deepEqual(storedFiles(), filesBefore)
    assert.deepEqual(fetched, [])
  })

  test('refuses to run when any used car or auction already exists, leaving it untouched', async () => {
    const existing = await Product.create({ make: 'Honda', model: 'Civic', year: 2019, km: 1000, price: 1 })
    await assert.rejects(run(), /already holds/)
    assert.equal(await Product.countDocuments(), 1)
    assert.equal(await Car.countDocuments(), 0)
    assert.equal((await Product.findById(existing._id)).price, 1)
    assert.deepEqual(fetched, [])

    await resetTestDatabase()
    await Car.create({ make: 'Honda', model: 'Civic', year: 2019, km: 1000, engine: '1800', basePrice: 1, auctionStart: NOW, auctionEnd: new Date(NOW.getTime() + DAY) })
    await assert.rejects(run(), /already holds/)
    assert.equal(await Product.countDocuments(), 0)
  })

  test('running it twice does not duplicate anything', async () => {
    await run()
    const filesBefore = storedFiles()
    await assert.rejects(run(), /already holds/)
    assert.equal(await Product.countDocuments(), 4)
    assert.equal(await Car.countDocuments(), 2)
    assert.deepEqual(storedFiles(), filesBefore, 'the second run stores nothing')
  })

  test('a photograph that cannot be downloaded or checked stops the run with nothing stored', async () => {
    const filesBefore = storedFiles()
    let calls = 0
    const failing = async photo => { calls += 1; if (calls === 4) throw new Error('not the reviewed original'); return fakePhoto(photo) }
    await assert.rejects(run({ fetchPhoto: failing }), /not the reviewed original/)
    assert.equal(calls, 4)
    assert.equal(await Product.countDocuments() + await Car.countDocuments(), 0)
    assert.deepEqual(storedFiles(), filesBefore, 'nothing was stored before the bad photograph was found')
  })

  test('is all-or-nothing: an invalid auction leaves no listing, no photo and no report behind', async () => {
    const filesBefore = storedFiles()
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
    assert.deepEqual(storedFiles(), filesBefore, 'everything stored before the failure is removed again')
  })

  test('in production it refuses to keep files on a local disk, and leaves nothing behind', async () => {
    const filesBefore = storedFiles()
    process.env.NODE_ENV = 'production'
    try {
      await assert.rejects(run(), /Cloudinary credentials are missing/)
    } finally {
      process.env.NODE_ENV = 'test'
    }
    assert.equal(await Product.countDocuments() + await Car.countDocuments(), 0)
    assert.deepEqual(storedFiles(), filesBefore)
    assert.deepEqual(fetched, [], 'it stops before downloading anything')
  })

  test('the public used-car list shows the seeded cars, without owner or seller details', async () => {
    await run()
    const response = await request(createApp()).get('/api/products')
    assert.equal(response.status, 200)
    const cars = Array.isArray(response.body) ? response.body : response.body.products
    assert.equal(cars.length, 4)
    assert.ok(!/ownerId|sellerEmail/.test(JSON.stringify(cars)))
    assert.ok(cars.every(item => item.images[0].startsWith('/uploads/images/')))
  })

  test('a stored photograph is served by the uploads route', async () => {
    await run()
    const product = await Product.findOne({ model: 'City' }).lean()
    const response = await request(createApp()).get(product.images[0])
    assert.equal(response.status, 200)
    assert.equal(response.body.subarray(0, 3).toString('hex'), 'ffd8ff')
  })
})

describe('downloading a pinned photograph', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a reviewed original')])
  const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex')
  const pinned = (buffer = jpeg, source = 'https://upload.wikimedia.org/wikipedia/commons/a/a0/Car.jpg') => ({ source, bytes: buffer.length, sha256: digest(buffer) })
  const answer = (body, status = 200) => mock.method(globalThis, 'fetch', async () => new Response(body, { status }))
  afterEach(() => mock.restoreAll())

  test('returns the file when its size and SHA-256 match the pin, and identifies itself to Wikimedia', async () => {
    const calls = []
    mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url: String(url), agent: options.headers['User-Agent'] }); return new Response(jpeg) })
    assert.deepEqual(await downloadPhoto(pinned()), jpeg)
    assert.equal(calls.length, 1)
    assert.match(calls[0].agent, /ExecutiveCarsCatalogSeed.+github\.com/)
  })

  test('refuses a file whose content differs from the pin, even by one byte', async () => {
    answer(Buffer.concat([jpeg.subarray(0, jpeg.length - 1), Buffer.from('X')]))
    await assert.rejects(downloadPhoto(pinned()), /not the reviewed original/)
  })

  test('refuses a file of the wrong size', async () => {
    answer(Buffer.concat([jpeg, Buffer.from('extra')]))
    await assert.rejects(downloadPhoto(pinned()), /not the reviewed original/)
  })

  test('refuses something that is not a JPEG even if it matches the pin', async () => {
    const notJpeg = Buffer.from('<html>a page, not a photograph</html>')
    answer(notJpeg)
    await assert.rejects(downloadPhoto(pinned(notJpeg)), /not a JPEG/)
  })

  test('refuses an unsuccessful answer', async () => {
    answer('Not Found', 404)
    await assert.rejects(downloadPhoto(pinned()), /HTTP 404/)
  })

  test('only fetches from Wikimedia over https, and never asks the network otherwise', async () => {
    const calls = []
    mock.method(globalThis, 'fetch', async url => { calls.push(String(url)); return new Response(jpeg) })
    for (const source of ['http://upload.wikimedia.org/a.jpg', 'https://example.com/a.jpg', 'https://upload.wikimedia.org.evil.example/a.jpg', 'https://evil.example/https://upload.wikimedia.org/a.jpg']) {
      await assert.rejects(downloadPhoto(pinned(jpeg, source)), /may only come from/, source)
    }
    assert.deepEqual(calls, [])
  })

  test('refuses a pin with no size or an oversized one', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(jpeg))
    await assert.rejects(downloadPhoto({ ...pinned(), bytes: 0 }), /1 byte to 10 MB/)
    await assert.rejects(downloadPhoto({ ...pinned(), bytes: 10 * 1024 * 1024 + 1 }), /1 byte to 10 MB/)
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

  test('the findings follow the stated condition and claim nothing that was not checked', () => {
    const results = condition => findings({ condition }).flatMap(([, items]) => items.map(([, result]) => result))
    const count = (items, value) => items.filter(item => item === value).length
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
    const cars = Array.isArray(response.body) ? response.body : response.body.products
    assert.ok(cars.every(item => item.hasInspectionReport === true && item.inspectionStatus === 'report_available'))
    assert.ok(!JSON.stringify(cars).includes('inspectionDocument'))
  })
})
