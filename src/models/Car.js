const mongoose = require('mongoose')

const carSchema = new mongoose.Schema({
  make:          { type: String, required: true, trim: true },
  model:         { type: String, required: true, trim: true },
  variant:       { type: String, trim: true },
  year:          { type: Number, required: true, min: 1900, max: new Date().getFullYear() + 1 },
  km:            { type: Number, required: true, min: 0 },
  engine:        { type: String, required: true },
  fuel:          { type: String, enum: ['Petrol', 'Diesel', 'CNG', 'Hybrid'], default: 'Petrol' },
  transmission:  { type: String, enum: ['Auto', 'Manual'], default: 'Auto' },
  color:         { type: String, trim: true },
  city:          { type: String, trim: true },
  registrationCity: { type: String, trim: true },
  bodyType:      { type: String, trim: true },
  assemblyType:  { type: String, enum: ['Local', 'Imported', 'Unknown'], default: 'Unknown' },
  condition:     { type: String, enum: ['Excellent', 'Good', 'Fair', 'Needs Work', 'Unknown'], default: 'Unknown' },
  verificationStatus: { type: String, enum: ['unverified', 'pending', 'verified'], default: 'unverified', index: true },
  inspectionStatus: { type: String, enum: ['not_available', 'pending', 'report_available'], default: 'not_available', index: true },
  inspectionScore: { type: Number, min: 0, max: 100 },
  images:        [{ type: String }],
  pdfUrl:        { type: String },
  basePrice:     { type: Number, required: true, min: 1 },
  reservePrice:  { type: Number, min: 1 },
  minimumBidIncrement: { type: Number, min: 1, default: 50000 },
  currentBid:    { type: Number, default: 0, min: 0 },
  highestBidder: { type: mongoose.Schema.Types.ObjectId, ref: 'Member' },
  bidCount:      { type: Number, default: 0, min: 0 },
  auctionStart:  { type: Date, required: true },
  auctionEnd:    { type: Date, required: true },
  description:   { type: String, trim: true },
  status:        { type: String, enum: ['active', 'ended', 'cancelled'], default: 'active' },
  ownerId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Member', index: true },
  sellerEmail:   { type: String, trim: true },
  demoKey:       { type: String, sparse: true, index: true },
}, { timestamps: true })

carSchema.pre('validate', function (next) {
  if (this.auctionStart && this.auctionEnd && this.auctionEnd <= this.auctionStart) {
    this.invalidate('auctionEnd', 'Auction end time must be after the start time')
  }
  next()
})

carSchema.index({ status: 1, auctionStart: 1, auctionEnd: 1 })

module.exports = mongoose.model('Car', carSchema)
