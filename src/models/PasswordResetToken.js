const mongoose = require('mongoose')

const passwordResetTokenSchema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true })

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema)
