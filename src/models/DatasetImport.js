const mongoose = require('mongoose')

const datasetImportSchema = new mongoose.Schema({
  fileName: { type: String, required: true, trim: true },
  source: { type: String, required: true, trim: true },
  importedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
  rightsConfirmed: { type: Boolean, required: true },
  report: {
    receivedRecords: { type: Number, default: 0 },
    importedRecords: { type: Number, default: 0 },
    rejectedRecords: { type: Number, default: 0 },
    duplicateRecords: { type: Number, default: 0 },
    usableRecords: { type: Number, default: 0 },
    missingFields: { type: Map, of: Number },
    rejectionReasons: { type: Map, of: Number },
  },
}, { timestamps: true })

module.exports = mongoose.model('DatasetImport', datasetImportSchema)
