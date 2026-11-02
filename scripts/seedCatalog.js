require('dotenv').config()

// Puts the platform's own sample catalogue into an EMPTY database: used cars for sale and car auctions, each with a
// photograph and a sample inspection report, and nothing else. No accounts, bids, bookings or payments are created, and
// no listing has an owner or a seller e-mail: every listing belongs to the platform. The data (specifications, prices,
// descriptions with photo credits) is in scripts/data/platformCatalog.json.
//
// Photographs: each one is pinned in the catalogue by the address of its original on Wikimedia Commons, its size and its
// SHA-256. The seed downloads it, refuses anything that does not match, and stores it the way an administrator's upload
// is stored (public Cloudinary image, resized like every upload; or the local uploads folder when Cloudinary is not
// configured). Nothing depends on files that were hosted earlier.
//
// Inspection reports: generated here as PDFs and stored like any report uploaded by an administrator (private storage,
// opened only through the authorised document routes). They say on every page that the vehicle was NOT inspected: the
// vehicles are samples. See scripts/lib/sampleInspectionReport.js.
//
//   node scripts/seedCatalog.js                              shows what would be written, writes nothing
//   CONFIRM_CATALOG_SEED=seed-platform-catalog node scripts/seedCatalog.js --execute
//
// It refuses to write unless the product and auction collections are both empty, so it can never overwrite or mix
// with listings that exist. If anything fails, everything it stored is removed again. To start over, delete the
// listings in the admin area first.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const mongoose = require('mongoose')
const connectDB = require('../src/config/db')
const Product = require('../src/models/Product')
const Car = require('../src/models/Car')
const {
  cloudinary, usingCloudinary, storedPrivateAsset, deletePrivateAsset, hasExpectedSignature, privateUploadDir, publicImageDir,
} = require('../src/config/cloudinary')
const { buildSampleReport } = require('./lib/sampleInspectionReport')
const catalog = require('./data/platformCatalog.json')

const DAY = 24 * 60 * 60 * 1000
const CONFIRMATION = 'seed-platform-catalog'
const PHOTO_HOST = 'upload.wikimedia.org'
const MAX_PHOTO_BYTES = 10 * 1024 * 1024
const USER_AGENT = 'ExecutiveCarsCatalogSeed/1.0 (https://github.com/waleedtariq7861/executivecars-backend)'

const withoutPlanning = ({ key, startsInDays, endsInDays, photo, ...fields }) => fields

const planCatalog = (now = new Date()) => ({
  products: catalog.products.map(item => ({
    key: item.key,
    photo: item.photo,
    fields: { ...withoutPlanning(item), listingType: 'used', status: 'available' },
  })),
  auctions: catalog.auctions.map(item => ({
    key: item.key,
    photo: item.photo,
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

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex')

/** Downloads one pinned photograph and checks it is exactly the reviewed original. */
const downloadPhoto = async ({ source, bytes, sha256: expected }) => {
  const url = new URL(source)
  if (url.protocol !== 'https:' || url.hostname !== PHOTO_HOST) throw new Error(`Photos may only come from https://${PHOTO_HOST}: ${source}`)
  if (!(bytes > 0 && bytes <= MAX_PHOTO_BYTES)) throw new Error(`A photo must be 1 byte to 10 MB: ${source}`)
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(90_000) })
  if (!response.ok) throw new Error(`Could not download ${source}: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length !== bytes || sha256(buffer) !== expected) throw new Error(`The photo at ${source} is not the reviewed original (size or SHA-256 differs)`)
  if (!hasExpectedSignature(buffer, 'image/jpeg')) throw new Error(`The photo at ${source} is not a JPEG`)
  return buffer
}

const reportFor = (item, now, options = {}) => buildSampleReport(item.fields, { reference: `EC-SAMPLE-${item.key.toUpperCase()}`, now, ...options })

// Checked once, before anything is downloaded or stored: a production run must never leave files on a local disk.
const requireDurableStorage = () => {
  if (!usingCloudinary && process.env.NODE_ENV === 'production') throw new Error('Refusing to store files on the local disk in production: the Cloudinary credentials are missing')
}

// Stored the way the upload middleware stores an administrator's public image.
const storePhoto = async buffer => {
  if (usingCloudinary) {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'executive-cars/images', resource_type: 'image', transformation: [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }] },
        (error, uploaded) => (error ? reject(error) : resolve(uploaded)),
      ).end(buffer)
    })
    return { url: result.secure_url, remove: () => cloudinary.uploader.destroy(result.public_id, { resource_type: 'image', type: 'upload', invalidate: true }) }
  }
  const filename = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}.jpg`
  await fs.promises.mkdir(publicImageDir, { recursive: true })
  await fs.promises.writeFile(path.join(publicImageDir, filename), buffer, { flag: 'wx' })
  return { url: `/uploads/images/${encodeURIComponent(filename)}`, remove: () => fs.promises.unlink(path.join(publicImageDir, filename)) }
}

// Stored the way the upload middleware stores an administrator's report: private Cloudinary storage when it is
// configured, otherwise the private folder on disk.
const storeReport = async buffer => {
  const file = { mimetype: 'application/pdf', size: buffer.length, resourceType: 'raw' }
  if (usingCloudinary) {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ folder: 'executive-cars/reports', resource_type: 'raw', type: 'authenticated' }, (error, uploaded) => (error ? reject(error) : resolve(uploaded))).end(buffer)
    })
    const asset = storedPrivateAsset({ ...file, filename: result.public_id, assetProvider: 'cloudinary', resourceType: result.resource_type })
    return { asset, remove: () => deletePrivateAsset(asset) }
  }
  const filename = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}.pdf`
  await fs.promises.mkdir(privateUploadDir, { recursive: true })
  await fs.promises.writeFile(path.join(privateUploadDir, filename), buffer, { flag: 'wx' })
  const asset = storedPrivateAsset({ ...file, filename, assetProvider: 'local' })
  return { asset, remove: () => deletePrivateAsset(asset) }
}

const discard = removals => Promise.all(removals.map(remove => Promise.resolve().then(remove).catch(error => console.warn(`Could not remove a stored file: ${error.message}`))))

const seedCatalog = async ({ now = new Date(), execute = false, confirmation = '', compress = true, fetchPhoto = downloadPhoto } = {}) => {
  const plan = planCatalog(now)
  if (await Product.exists({}) || await Car.exists({})) {
    throw new Error('Refusing to seed: the database already holds used cars or auctions')
  }
  const items = [...plan.products, ...plan.auctions]
  const reports = await Promise.all(items.map(item => reportFor(item, now, { compress })))
  const summary = { products: plan.products.length, auctions: plan.auctions.length, photos: items.length, reports: reports.length }
  if (!execute) return { executed: false, ...summary, plan, reportBytes: reports.map(report => report.length) }
  if (confirmation !== CONFIRMATION) throw new Error(`Set CONFIRM_CATALOG_SEED=${CONFIRMATION} to write the catalogue`)

  requireDurableStorage()

  // Everything is downloaded and checked before anything is stored, so a bad photo stops the run with nothing written.
  const photos = []
  for (const item of items) photos.push(await fetchPhoto(item.photo))

  const removals = []
  try {
    const stored = new Map()
    for (const [index, item] of items.entries()) {
      const photo = await storePhoto(photos[index])
      removals.push(photo.remove)
      const report = await storeReport(reports[index])
      removals.push(report.remove)
      stored.set(item, { images: [photo.url], inspectionDocument: report.asset })
    }
    await mongoose.connection.transaction(async session => {
      await Product.create(plan.products.map(item => ({ ...item.fields, ...stored.get(item) })), { session, ordered: true })
      await Car.create(plan.auctions.map(item => ({ ...item.fields, ...stored.get(item) })), { session, ordered: true })
    })
  } catch (error) {
    await discard(removals)
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
  console.log(`Photos and inspection reports are stored in: ${usingCloudinary ? 'Cloudinary (photos public, reports private)' : 'the uploads folders on the local disk'}`)
  const result = await seedCatalog({ execute, confirmation: process.env.CONFIRM_CATALOG_SEED })
  if (result.executed) console.log(`Written: ${result.products} used cars and ${result.auctions} auctions, all owned by the platform, each with a photo and a sample inspection report.`)
  else console.log(`Dry run, nothing written or downloaded. Would create (each with a photo from Wikimedia Commons and a sample inspection report):\n${describe(result.plan)}\nRun again with --execute (and CONFIRM_CATALOG_SEED=${CONFIRMATION}) to write.`)
}

if (require.main === module) {
  main()
    .catch(error => { console.error(`Catalogue seed failed: ${error.message}`); process.exitCode = 1 })
    .finally(() => mongoose.disconnect())
}

module.exports = { planCatalog, seedCatalog, downloadPhoto, CONFIRMATION }
