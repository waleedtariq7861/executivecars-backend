const mongoose = require('mongoose')

// One attempt to pay for something (today: the annual auction membership). Everything the invoice needs is
// copied onto the record when the payment is created or settled, so an invoice never changes afterwards.
// Card numbers, wallet PINs and CVCs are never stored: only the brand and the last four digits.
const paymentSchema = new mongoose.Schema({
  memberId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true, index: true },
  reference: { type: String, required: true, unique: true },
  plan:      { type: String, required: true },
  description: { type: String, required: true },
  amount:    { type: Number, required: true, min: 1 },
  currency:  { type: String, required: true, default: 'PKR' },
  provider:  { type: String, enum: ['sandbox'], required: true, default: 'sandbox' },
  method:    { type: String, enum: ['card', 'wallet', 'bank_transfer'] },
  // requires_payment -> processing -> succeeded | failed ; bank transfers go processing -> pending_verification -> succeeded | failed
  status:    { type: String, enum: ['requires_payment', 'processing', 'pending_verification', 'succeeded', 'failed', 'expired'], required: true, default: 'requires_payment', index: true },
  methodDetails: {
    brand: String, last4: String,                         // card
    wallet: String, maskedNumber: String,                 // wallet (jazzcash | easypaisa)
    bankReference: String, transferDate: Date,            // bank transfer
  },
  failureCode:    String,
  failureMessage: String,
  billing: { name: String, email: String, phone: String },
  expiresAt:   { type: Date, required: true },
  submittedAt: Date,
  paidAt:      Date,
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  invoiceNumber:   { type: String, unique: true, sparse: true },
  invoiceIssuedAt: Date,
}, { timestamps: true })

paymentSchema.index({ status: 1, createdAt: -1 })

module.exports = mongoose.model('Payment', paymentSchema)
