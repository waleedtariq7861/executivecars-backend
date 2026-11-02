const mongoose = require('mongoose')

// One pending password-reset code per customer or administrator account. Only a keyed digest of the code is
// stored; the digest covers the account's address, so the code is tied to the address it was mailed to.
// A few wrong guesses are allowed before it dies.
const passwordResetCodeSchema = new mongoose.Schema({
  accountModel: { type: String, enum: ['member', 'admin'], required: true },
  accountId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  otpDigest:    { type: String, required: true },
  expiresAt:    { type: Date, required: true, index: { expires: 0 } },
  attempts:     { type: Number, default: 0 },
}, { timestamps: true })

passwordResetCodeSchema.index({ accountModel: 1, accountId: 1 }, { unique: true })

module.exports = mongoose.model('PasswordResetCode', passwordResetCodeSchema)
