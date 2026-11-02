const mongoose = require('mongoose')

// Proof that an administrator has just given the right password and now owes the second factor. It is not a
// session: it only lets the one request that completes the sign-in through. Only the token's hash is stored.
const mfaChallengeSchema = new mongoose.Schema({
  adminId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  attempts:  { type: Number, default: 0 },
}, { timestamps: true })

module.exports = mongoose.model('MfaChallenge', mfaChallengeSchema)
