const mongoose = require('mongoose')

const vehicleRecordSchema = new mongoose.Schema({
  make: { type: String, required: true, trim: true, index: true },
  model: { type: String, required: true, trim: true, index: true },
  variant: { type: String, trim: true },
  modelYear: { type: Number, required: true, min: 1980, max: new Date().getFullYear() + 1, index: true },
  registrationCity: { type: String, trim: true },
  listingCity: { type: String, trim: true },
  engineCapacity: { type: Number, min: 0 },
  fuelType: { type: String, trim: true },
  transmission: { type: String, trim: true },
  mileage: { type: Number, required: true, min: 0 },
  bodyType: { type: String, trim: true },
  assemblyType: { type: String, trim: true },
  colour: { type: String, trim: true },
  condition: { type: String, trim: true },
  numberOfOwners: { type: Number, min: 0 },
  inspectionScore: { type: Number, min: 0, max: 100 },
  listingPrice: { type: Number, required: true, min: 1, index: true },
  finalSalePrice: { type: Number, min: 1 },
  listingDate: { type: Date },
  source: { type: String, required: true, trim: true },
  sourceUrl: { type: String, trim: true },
  importBatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'DatasetImport', index: true },
  fingerprint: { type: String, required: true, unique: true },
}, { timestamps: true })

vehicleRecordSchema.index({ make: 1, model: 1, modelYear: 1, listingPrice: 1 })

module.exports = mongoose.model('VehicleRecord', vehicleRecordSchema)
