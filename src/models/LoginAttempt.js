const mongoose = require('mongoose')

// Counter for one throttle bucket: failed sign-ins (an IP + email pair, an email, or an IP) or password-reset
// requests for one account.
// `key` is a hash, so the collection holds no addresses. MongoDB removes buckets once they are
// neither inside their counting window nor blocked.
const loginAttemptSchema = new mongoose.Schema({
  key:             { type: String, required: true, unique: true },
  failures:        { type: Number, default: 0 },
  windowStartedAt: { type: Date, required: true },
  blockedUntil:    { type: Date },
  expireAt:        { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true })

module.exports = mongoose.model('LoginAttempt', loginAttemptSchema)
