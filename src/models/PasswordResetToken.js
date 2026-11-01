const mongoose = require('mongoose')

// Single-use reset links for every kind of account. Only the SHA-256 of the link's token is stored.
// Records created before administrators could reset have no accountModel and are customer accounts.
const passwordResetTokenSchema = new mongoose.Schema({
  accountModel: { type: String, enum: ['member', 'admin', 'seller'], default: 'member' },
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true })

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema)
