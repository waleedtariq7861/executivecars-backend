const mongoose = require('mongoose')

// Server-side session record. The browser holds a random token; only its SHA-256
// is stored, so a leaked database cannot be replayed as a login.
const sessionSchema = new mongoose.Schema({
  tokenHash:         { type: String, required: true, unique: true },
  accountModel:      { type: String, enum: ['member', 'admin'], required: true },
  accountId:         { type: mongoose.Schema.Types.ObjectId, required: true },
  role:              { type: String, enum: ['user', 'admin'], required: true },
  lastSeenAt:        { type: Date, required: true },
  idleExpiresAt:     { type: Date, required: true },
  absoluteExpiresAt: { type: Date, required: true },
  // MongoDB removes the record once the absolute lifetime has passed.
  expireAt:          { type: Date, required: true, index: { expires: 0 } },
  ip:                { type: String },
  userAgent:         { type: String },
  revokedAt:         { type: Date },
  revokedReason:     { type: String },
}, { timestamps: true })

sessionSchema.index({ accountModel: 1, accountId: 1 })

module.exports = mongoose.model('Session', sessionSchema)
