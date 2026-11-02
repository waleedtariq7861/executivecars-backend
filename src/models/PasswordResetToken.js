const mongoose = require('mongoose')

// Single-use reset links for customers and administrators. Only the SHA-256 of the link's token is stored.
const passwordResetTokenSchema = new mongoose.Schema({
  accountModel: { type: String, enum: ['member', 'admin'], required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true })

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema)
