const mongoose = require('mongoose')

const EVENT_TYPES = [
  'registered', 'login_success', 'login_failure', 'logout',
  'password_changed', 'reset_requested', 'reset_completed',
  'email_verified', 'session_revoked', 'mail_failed',
  'mfa_enabled', 'mfa_disabled', 'mfa_failed', 'recovery_code_used', 'recovery_codes_regenerated',
]

// Audit trail of account-security events. It holds no secrets: the e-mail address is masked, there are no
// codes or tokens, and `detail` is a short fixed label (a mail kind, a revoke reason). Old events expire.
const authEventSchema = new mongoose.Schema({
  type:         { type: String, enum: EVENT_TYPES, required: true },
  accountModel: { type: String, enum: ['member', 'admin'] },
  accountId:    { type: mongoose.Schema.Types.ObjectId },
  email:        { type: String, maxlength: 120 },
  ip:           { type: String, maxlength: 64 },
  userAgent:    { type: String, maxlength: 200 },
  detail:       { type: String, maxlength: 80 },
  createdAt:    { type: Date, default: Date.now, index: { expires: 180 * 24 * 60 * 60 } },
})

authEventSchema.index({ accountModel: 1, accountId: 1, createdAt: -1 })
authEventSchema.index({ type: 1, createdAt: -1 })

const AuthEvent = mongoose.model('AuthEvent', authEventSchema)
AuthEvent.EVENT_TYPES = EVENT_TYPES

module.exports = AuthEvent
