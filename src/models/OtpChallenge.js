const mongoose = require('mongoose')

const otpChallengeSchema = new mongoose.Schema({
  email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
  otpDigest:  { type: String, required: true },
  expiresAt:  { type: Date, required: true, expires: 0 },
  verified:   { type: Boolean, default: false },
  attempts:   { type: Number, default: 0 },
  demoKey:    { type: String, sparse: true, index: true },
}, { timestamps: true })

module.exports = mongoose.model('OtpChallenge', otpChallengeSchema)
