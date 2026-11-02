require('dotenv').config()

// Puts the platform's own sample catalogue into an EMPTY database: used cars for sale and car auctions, each with a
// sample inspection report, and nothing else. No accounts, bids, bookings or payments are created, and no listing has
// an owner or a seller e-mail: every listing belongs to the platform. The data (specifications, prices, descriptions
// with photo credits, photos already hosted on Cloudinary) is in scripts/data/platformCatalog.json.
//
// The inspection reports are generated here as PDFs and stored like any report uploaded by an administrator (private
// storage, opened only through the authorised document routes). They say on every page that the vehicle was NOT
// inspected: the vehicles are samples. See scripts/lib/sampleInspectionReport.js.
//
//   node scripts/seedCatalog.js                              shows what would be written, writes nothing
//   CONFIRM_CATALOG_SEED=seed-platform-catalog node scripts/seedCatalog.js --execute
//
// It refuses to write unless the product and auction collections are both empty, so it can never overwrite or mix
// with listings that exist. To start over, delete the listings in the admin area first.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const mongoose = require('mongoose')
const connectDB = require('../src/config/db')
const Product = require('../src/models/Product')
const Car = require('../src/models/Car')
const { cloudinary, usingCloudinary, storedPrivateAsset, deletePrivateAsset, privateUploadDir } = require('../src/config/cloudinary')
const { buildSampleReport } = require('./lib/sampleInspectionReport')
const catalog = require('./data/platformCatalog.json')

const DAY = 24 * 60 * 60 * 1000
const CONFIRMATION = 'seed-platform-catalog'

const withoutPlanning = ({ key, startsInDays, endsInDays, ...fields }) => fields

const planCatalog = (now = new Date()) => ({
  products: catalog.products.map(item => ({
    key: item.key,
    fields: { ...withoutPlanning(item), listingType: 'used', status: 'available' },
  })),
  auctions: catalog.auctions.map(item => ({
    key: item.key,
    fields: {
      ...withoutPlanning(item),
      currentBid: item.basePrice,
      bidCount: 0,
      status: 'active',
      auctionStart: new Date(now.getTime() + item.startsInDays * DAY),
      auctionEnd: new Date(now.getTime() + item.endsInDays * DAY),
    },
  })),
})

const reportFor = (item, now, options = {}) => buildSampleReport(item.fields, { reference: `EC-SAMPLE-${item.key.toUpperCase()}`, now, ...options })

// Stored the way the upload middleware stores an administrator's report: private Cloudinary storage when it is
// configured, otherwise the private folder on disk.
const storeReport = async buffer => {
  const file = { mimetype: 'application/pdf', size: buffer.length, resourceType: 'raw' }
  if (usingCloudinary) {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ folder: 'executive-cars/reports', resource_type: 'raw', type: 'authenticated' }, (error, uploaded) => (error ? reject(error) : resolve(uploaded))).end(buffer)
    })
    return storedPrivateAsset({ ...file, filename: result.public_id, assetProvider: 'cloudinary', resourceType: result.resource_type })
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to store reports on the local disk in production: the Cloudinary credentials are missing')
  const filename = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}.pdf`
  await fs.promises.mkdir(privateUploadDir, { recursive: true })
  await fs.promises.writeFile(path.join(privateUploadDir, filename), buffer, { flag: 'wx' })
  return storedPrivateAsset({ ...file, filename, assetProvider: 'local' })
}

const discard = assets => Promise.all(assets.map(asset => deletePrivateAsset(asset).catch(error => console.warn(`Could not remove a stored report (${asset.key}): ${error.message}`))))

const seedCatalog = async ({ now = new Date(), execute = false, confirmation = '', compress = true } = {}) => {
  const plan = planCatalog(now)
  if (await Product.exists({}) || await Car.exists({})) {
    throw new Error('Refusing to seed: the database already holds used cars or auctions')
  }
  const items = [...plan.products, ...plan.auctions]
  const reports = await Promise.all(items.map(item => reportFor(item, now, { compress })))
  const summary = { products: plan.products.length, auctions: plan.auctions.length, reports: reports.length }
  if (!execute) return { executed: false, ...summary, plan, reportBytes: reports.map(report => report.length) }
  if (confirmation !== CONFIRMATION) throw new Error(`Set CONFIRM_CATALOG_SEED=${CONFIRMATION} to write the catalogue`)

  const stored = []
  try {
    for (const report of reports) stored.push(await storeReport(report))
    const documents = new Map(items.map((item, index) => [item, stored[index]]))
    await mongoose.connection.transaction(async session => {
      await Product.create(plan.products.map(item => ({ ...item.fields, inspectionDocument: documents.get(item) })), { session, ordered: true })
      await Car.create(plan.auctions.map(item => ({ ...item.fields, inspectionDocument: documents.get(item) })), { session, ordered: true })
    })
  } catch (error) {
    await discard(stored)
    throw error
  }
  return { executed: true, ...summary }
}

const describe = plan => [
  ...plan.products.map(({ fields: item }) => `  used car  ${item.year} ${item.make} ${item.model} ${item.variant || ''}  PKR ${item.price.toLocaleString('en-US')}`),
  ...plan.auctions.map(({ fields: item }) => `  auction   ${item.year} ${item.make} ${item.model} ${item.variant || ''}  base PKR ${item.basePrice.toLocaleString('en-US')}  ${item.auctionStart.toISOString().slice(0, 10)} to ${item.auctionEnd.toISOString().slice(0, 10)}`),
].join('\n')

const main = async () => {
  const execute = process.argv.includes('--execute')
  if (process.argv.slice(2).some(arg => arg !== '--execute')) throw new Error('The only option is --execute')
  await connectDB()
  console.log(`Target database: ${mongoose.connection.name} on ${mongoose.connection.host}`)
  console.log(`Inspection reports are stored in: ${usingCloudinary ? 'private Cloudinary storage' : 'the private folder on the local disk'}`)
  const result = await seedCatalog({ execute, confirmation: process.env.CONFIRM_CATALOG_SEED })
  if (result.executed) console.log(`Written: ${result.products} used cars and ${result.auctions} auctions, all owned by the platform, each with a sample inspection report (${result.reports}).`)
  else console.log(`Dry run, nothing written. Would create (each with a sample inspection report):\n${describe(result.plan)}\nRun again with --execute (and CONFIRM_CATALOG_SEED=${CONFIRMATION}) to write.`)
}

if (require.main === module) {
  main()
    .catch(error => { console.error(`Catalogue seed failed: ${error.message}`); process.exitCode = 1 })
    .finally(() => mongoose.disconnect())
}

module.exports = { planCatalog, seedCatalog, CONFIRMATION }
