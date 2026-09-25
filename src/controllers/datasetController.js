const DatasetImport = require('../models/DatasetImport')
const VehicleRecord = require('../models/VehicleRecord')
const { parseDataset, cleanDataset } = require('../services/datasetImportService')
const { handleControllerError } = require('../utils/http')

const importDataset = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose a CSV or JSON dataset file' })
    const source = String(req.body.source || '').trim()
    const rightsConfirmed = String(req.body.rightsConfirmed).toLowerCase() === 'true'
    if (!source) return res.status(400).json({ message: 'Describe the dataset source' })
    if (!rightsConfirmed) return res.status(400).json({ message: 'Confirm that this dataset may legally be used for the project' })

    const rows = parseDataset(req.file)
    if (!rows.length) return res.status(400).json({ message: 'The dataset contains no data rows' })
    if (rows.length > 25000) return res.status(413).json({ message: 'Import at most 25,000 records per file' })

    const { records, report } = cleanDataset(rows, source)
    const batch = await DatasetImport.create({
      fileName: req.file.originalname,
      source,
      importedBy: req.user._id,
      rightsConfirmed,
      report,
    })

    let importedRecords = 0
    if (records.length) {
      const result = await VehicleRecord.bulkWrite(records.map(record => ({
        updateOne: {
          filter: { fingerprint: record.fingerprint },
          update: { $setOnInsert: { ...record, importBatchId: batch._id } },
          upsert: true,
        },
      })), { ordered: false })
      importedRecords = result.upsertedCount || 0
    }

    report.importedRecords = importedRecords
    report.duplicateRecords += Math.max(0, records.length - importedRecords)
    report.usableRecords = importedRecords
    batch.report = report
    await batch.save()
    res.status(201).json({ message: 'Dataset import completed', import: batch })
  } catch (error) {
    handleControllerError(res, error, 'Dataset import failed')
  }
}

const getDatasetImports = async (req, res) => {
  try {
    const imports = await DatasetImport.find().sort({ createdAt: -1 }).limit(100).populate('importedBy', 'name email')
    res.json(imports)
  } catch (error) {
    handleControllerError(res, error, 'Could not load dataset imports')
  }
}

const getDatasetSummary = async (req, res) => {
  try {
    const [rowCount, latestImport, makeCounts, sourceCounts] = await Promise.all([
      VehicleRecord.countDocuments(),
      DatasetImport.findOne().sort({ createdAt: -1 }),
      VehicleRecord.aggregate([{ $group: { _id: '$make', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      VehicleRecord.aggregate([{ $group: { _id: '$source', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 20 }]),
    ])
    res.json({
      rowCount,
      trainingSource: 'Administrator-imported MongoDB vehicle records',
      latestImport,
      commonMakes: makeCounts.map(item => ({ make: item._id, count: item.count })),
      sources: sourceCounts.map(item => ({ source: item._id, count: item.count })),
    })
  } catch (error) {
    handleControllerError(res, error, 'Could not load dataset summary')
  }
}

const exportTrainingRecords = async (req, res) => {
  try {
    const records = await VehicleRecord.find().select('-_id -__v -fingerprint -importBatchId -createdAt -updatedAt').lean()
    res.json({ records })
  } catch (error) {
    handleControllerError(res, error, 'Could not export training records')
  }
}

module.exports = { importDataset, getDatasetImports, getDatasetSummary, exportTrainingRecords }
