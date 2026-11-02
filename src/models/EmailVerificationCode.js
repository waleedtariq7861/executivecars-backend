const mongoose = require('mongoose')

// One pending email-verification code per customer account. Only a keyed digest of the code is stored.
// The same record carries the resend allowance (one a minute, five a day), so a code that is replaced
// still counts against it.
const emailVerificationCodeSchema = new mongoose.Schema({
  accountId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true, unique: true },
  email:        { type: String, required: true, lowercase: true, trim: true },
  otpDigest:    { type: String, required: true },
  expiresAt:    { type: Date, required: true, index: { expires: 0 } },
  attempts:     { type: Number, default: 0 },
  lastSentAt:   { type: Date, required: true },
  dayStartedAt: { type: Date, required: true },
  sentToday:    { type: Number, default: 1 },
}, { timestamps: true })

module.exports = mongoose.model('EmailVerificationCode', emailVerificationCodeSchema)
