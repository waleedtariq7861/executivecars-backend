const mongoose = require('mongoose')

const bidSchema = new mongoose.Schema({
  carId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Car', required: true },
  bidderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  amount:   { type: Number, required: true, min: 1 },
  demoKey:  { type: String, sparse: true, index: true },
}, { timestamps: true })

bidSchema.index({ carId: 1, bidderId: 1, createdAt: -1 })

module.exports = mongoose.model('Bid', bidSchema)
