require('dotenv').config()
const fs = require('fs/promises')
const path = require('path')
const mongoose = require('mongoose')
const connectDB = require('../src/config/db')
const Car = require('../src/models/Car')
const Product = require('../src/models/Product')

const apply = process.argv.includes('--apply')
const missingPrivateAsset = {
  $or: [
    { 'inspectionDocument.key': { $exists: false } },
    { 'inspectionDocument.key': null },
    { 'inspectionDocument.key': '' },
  ],
}
const unsafeLegacyReport = {
  $and: [
    missingPrivateAsset,
    { $or: [
      { inspectionStatus: 'report_available' },
      { inspectionScore: { $exists: true } },
      { pdfUrl: { $exists: true, $nin: [null, ''] } },
    ] },
  ],
}
const legacyDemoDescription = {
  demoKey: 'executive-cars-demo:product:used-swift',
  description: 'Well-kept automatic Swift with current inspection report.',
  ...missingPrivateAsset,
}

const summarize = records => records.map(record => ({
  id: String(record._id),
  demoKey: record.demoKey || null,
  make: record.make,
  model: record.model,
  year: record.year,
  inspectionStatus: record.inspectionStatus,
  inspectionScore: record.inspectionScore ?? null,
  hasPrivateInspectionDocument: Boolean(record.inspectionDocument?.key),
  legacyPdfUrlPresent: Boolean(record.pdfUrl),
  description: record.description || null,
}))

async function main() {
  await connectDB()
  const fields = '_id demoKey make model year inspectionStatus inspectionScore inspectionDocument pdfUrl description'
  const [products, auctions, demoDescriptions, productCount, auctionCount, swiftDemo] = await Promise.all([
    Product.find(unsafeLegacyReport).select(fields).lean(),
    Car.find(unsafeLegacyReport).select(fields).lean(),
    Product.find(legacyDemoDescription).select(fields).lean(),
    Product.countDocuments(),
    Car.countDocuments(),
    Product.findOne({ demoKey: 'executive-cars-demo:product:used-swift' }).select(fields).lean(),
  ])

  const backup = {
    generatedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    rule: 'Any legacy report metadata without inspectionDocument.key becomes not_available; inspectionScore and permanent pdfUrl are removed',
    products: summarize(products),
    auctions: summarize(auctions),
    demoDescriptions: summarize(demoDescriptions),
  }

  console.log(JSON.stringify({
    mode: backup.mode,
    affectedProducts: products.length,
    affectedAuctions: auctions.length,
    affectedDemoDescriptions: demoDescriptions.length,
    affectedTotal: products.length + auctions.length + demoDescriptions.length,
    inventoryProducts: productCount,
    inventoryAuctions: auctionCount,
    swiftDemo: swiftDemo ? summarize([swiftDemo])[0] : null,
  }, null, 2))

  if (!apply) {
    console.log('Dry run only. Use npm run repair:inspection-reports:apply to back up and repair these records.')
    return
  }

  const reportsDirectory = path.resolve(__dirname, '..', 'reports')
  await fs.mkdir(reportsDirectory, { recursive: true })
  const timestamp = backup.generatedAt.replace(/[:.]/g, '-')
  const backupPath = path.join(reportsDirectory, `inspection-report-repair-${timestamp}.json`)
  await fs.writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, { flag: 'wx' })

  const [productResult, auctionResult] = await Promise.all([
    Product.updateMany(unsafeLegacyReport, { $set: { inspectionStatus: 'not_available' }, $unset: { inspectionScore: 1, pdfUrl: 1 } }),
    Car.updateMany(unsafeLegacyReport, { $set: { inspectionStatus: 'not_available' }, $unset: { inspectionScore: 1, pdfUrl: 1 } }),
  ])

  const demoDescriptionResult = await Product.updateOne(
    legacyDemoDescription,
    { $set: { description: 'Well-kept automatic Swift with documented service history.' } },
  )

  console.log(JSON.stringify({
    backupPath,
    repairedProducts: productResult.modifiedCount,
    repairedAuctions: auctionResult.modifiedCount,
    repairedDemoDescriptions: demoDescriptionResult.modifiedCount,
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
