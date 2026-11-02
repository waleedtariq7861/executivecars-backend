const AuthEvent = require('../models/AuthEvent')
const Admin = require('../models/Admin')
const Member = require('../models/Member')
const { handleControllerError } = require('../utils/http')
const { eventDto } = require('./securityController')

const DAY_MS = 24 * 60 * 60 * 1000

// Everything that happened to accounts, for administrators: failed sign-ins, password resets and, above all,
// security mail that could not be delivered (a customer must never learn that, but an administrator has to).
const listAuthEvents = async (req, res) => {
  try {
    const filter = AuthEvent.EVENT_TYPES.includes(req.query.type) ? { type: req.query.type } : {}
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 100))
    const since = new Date(Date.now() - DAY_MS)
    const [events, loginFailures, mailFailures, resets] = await Promise.all([
      AuthEvent.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      AuthEvent.countDocuments({ type: 'login_failure', createdAt: { $gte: since } }),
      AuthEvent.countDocuments({ type: 'mail_failed', createdAt: { $gte: since } }),
      AuthEvent.countDocuments({ type: 'reset_requested', createdAt: { $gte: since } }),
    ])

    const idsFor = model => [...new Set(events.filter(event => event.accountModel === model && event.accountId).map(event => String(event.accountId)))]
    const [members, admins] = await Promise.all([
      Member.find({ _id: { $in: idsFor('member') } }).select('name email').lean(),
      Admin.find({ _id: { $in: idsFor('admin') } }).select('name email').lean(),
    ])
    const names = { member: new Map(members.map(item => [String(item._id), item])), admin: new Map(admins.map(item => [String(item._id), item])) }

    res.set('Cache-Control', 'no-store')
    res.json({
      summary: { loginFailures24h: loginFailures, mailFailures24h: mailFailures, resetRequests24h: resets },
      events: events.map(event => {
        const account = event.accountId ? names[event.accountModel]?.get(String(event.accountId)) : null
        return {
          ...eventDto(event),
          accountModel: event.accountModel,
          email: event.email,
          account: account ? { name: account.name, email: account.email } : null,
        }
      }),
    })
  } catch (error) {
    handleControllerError(res, error, 'Could not load the security events')
  }
}

module.exports = { listAuthEvents }
