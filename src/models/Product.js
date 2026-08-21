const mongoose = require('mongoose')

const productSchema = new mongoose.Schema({
  make:         { type: String, required: true, trim: true },
  model:        { type: String, required: true, trim: true },
  variant:      { type: String, trim: true },
  year:         { type: Number, required: true, min: 1900, max: new Date().getFullYear() + 1 },
  km:           { type: Number, required: true, min: 0 },
  price:        { type: Number, required: true, min: 1 },
  engine:       { type: String, trim: true },
  fuel:         { type: String, enum: ['Petrol', 'Diesel', 'CNG', 'Hybrid'], default: 'Petrol' },
  transmission: { type: String, enum: ['Auto', 'Manual'], default: 'Auto' },
  color:        { type: String, trim: true },
  city:         { type: String, trim: true },
  registrationCity: { type: String, trim: true },
  bodyType:     { type: String, trim: true },
  assemblyType: { type: String, enum: ['Local', 'Imported', 'Unknown'], default: 'Unknown' },
  condition:    { type: String, enum: ['Excellent', 'Good', 'Fair', 'Needs Work', 'Unknown'], default: 'Unknown' },
  verificationStatus: { type: String, enum: ['unverified', 'pending', 'verified'], default: 'unverified', index: true },
  inspectionStatus: { type: String, enum: ['not_available', 'pending', 'report_available'], default: 'not_available', index: true },
  inspectionScore: { type: Number, min: 0, max: 100 },
  images:       [{ type: String }],
  pdfUrl:       { type: String },
  description:  { type: String, trim: true },
  status:       { type: String, enum: ['available', 'sold'], default: 'available' },
  listingType:  { type: String, enum: ['new', 'used'], default: 'used' },
  ownerId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Member', index: true },
  sellerEmail:  { type: String, trim: true },
  demoKey:      { type: String, sparse: true, index: true },
}, { timestamps: true })

productSchema.index({ status: 1, createdAt: -1 })
productSchema.index({ make: 1, model: 1, year: 1, price: 1 })

module.exports = mongoose.model('Product', productSchema)
