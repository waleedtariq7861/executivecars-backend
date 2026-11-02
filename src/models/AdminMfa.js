const mongoose = require('mongoose')

// Second sign-in factor (authenticator app) of one administrator. Kept apart from the Admin record so it can
// never travel with it by accident. The TOTP secret is stored encrypted, never in the clear; the recovery codes are
// stored as keyed digests and each works once.
const adminMfaSchema = new mongoose.Schema({
  adminId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, unique: true },
  // Encrypted secrets are never returned unless a query asks for them with select('+field').
  secretCipher:  { type: String, select: false },
  // A secret that has been shown but not yet confirmed with a first code; it protects nothing until then.
  pendingCipher: { type: String, select: false },
  enabledAt:     { type: Date },
  // The newest 30-second step that was accepted, so a code cannot be used twice.
  lastUsedStep:  { type: Number, default: 0 },
  recoveryCodes: {
    type: [new mongoose.Schema({ hash: { type: String, required: true }, usedAt: { type: Date } }, { _id: false })],
    select: false,
    default: [],
  },
}, { timestamps: true })

module.exports = mongoose.model('AdminMfa', adminMfaSchema)
