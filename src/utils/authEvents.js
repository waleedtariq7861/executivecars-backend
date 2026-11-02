const AuthEvent = require('../models/AuthEvent')

const maskEmail = (value) => {
  const [local, domain] = String(value || '').trim().toLowerCase().split('@')
  return local && domain ? `${local.slice(0, 1)}***@${domain}` : undefined
}

const clientAgent = req => String(req?.get?.('user-agent') || '').slice(0, 200) || undefined

/**
 * Writes one audit event. The audit trail must never be able to break the action it describes, so a failure to
 * write is reported on the server log (never swallowed silently) and the caller carries on.
 */
const recordAuthEvent = async (type, { req, accountModel, accountId, email, detail } = {}) => {
  try {
    await AuthEvent.create({ type, accountModel, accountId, email: maskEmail(email), ip: req?.ip, userAgent: clientAgent(req), detail })
  } catch (error) {
    console.error(`Could not record the "${type}" security event:`, error.message)
  }
}

// What a person sees about their own account: newest first.
const listForAccount = (accountModel, accountId, limit = 30) =>
  AuthEvent.find({ accountModel, accountId }).sort({ createdAt: -1 }).limit(limit).lean()

module.exports = { recordAuthEvent, listForAccount, maskEmail }
