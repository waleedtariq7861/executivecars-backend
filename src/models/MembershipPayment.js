const mongoose = require('mongoose')

const membershipPaymentSchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true, index: true },
  amount: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true, default: 'PKR' },
  plan: { type: String, required: true },
  paymentMode: { type: String, enum: ['demo'], required: true },
  status: { type: String, enum: ['completed'], required: true },
}, { timestamps: true })

module.exports = mongoose.model('MembershipPayment', membershipPaymentSchema)
