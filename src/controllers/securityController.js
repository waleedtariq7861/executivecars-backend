const mongoose = require('mongoose')
const Session = require('../models/Session')
const sessions = require('../utils/sessions')
const { describeDevice } = require('../utils/device')
const { recordAuthEvent, listForAccount } = require('../utils/authEvents')
const { handleControllerError } = require('../utils/http')

const eventDto = event => ({
  id: event._id,
  type: event.type,
  at: event.createdAt,
  ip: event.ip,
  device: describeDevice(event.userAgent),
  detail: event.detail,
})

// The signed-in person's own live sessions (this browser and any other). Works for customers and administrators.
const listSessions = async (req, res) => {
  try {
    const now = new Date()
    const live = await Session.find({
      accountModel: req.accountModel, accountId: req.user._id,
      revokedAt: { $exists: false }, idleExpiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now },
    }).sort({ lastSeenAt: -1 })
    res.set('Cache-Control', 'no-store')
    res.json({
      sessions: live.map(item => ({
        id: item._id,
        current: String(item._id) === String(req.session._id),
        device: describeDevice(item.userAgent),
        ip: item.ip,
        signedInAt: item.createdAt,
        lastSeenAt: item.lastSeenAt,
        expiresAt: new Date(Math.min(item.idleExpiresAt.getTime(), item.absoluteExpiresAt.getTime())),
      })),
    })
  } catch (error) {
    handleControllerError(res, error, 'Could not load your sessions')
  }
}

// Signs one of the person's OTHER sessions out. The current one ends with "Sign out".
const revokeOneSession = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Session not found' })
    if (String(req.params.id) === String(req.session._id)) {
      return res.status(400).json({ message: 'Use Sign out to end the session you are using.', code: 'CURRENT_SESSION' })
    }
    const target = await Session.findOne({
      _id: req.params.id, accountModel: req.accountModel, accountId: req.user._id, revokedAt: { $exists: false },
    })
    if (!target) return res.status(404).json({ message: 'Session not found' })
    await sessions.revokeSession(target, 'user_revoked', req.app.get('io'))
    await recordAuthEvent('session_revoked', { req, accountModel: req.accountModel, accountId: req.user._id, email: req.user.email, detail: 'one other session' })
    res.json({ revoked: 1 })
  } catch (error) {
    handleControllerError(res, error, 'Could not sign that session out')
  }
}

const revokeOtherSessions = async (req, res) => {
  try {
    const revoked = await sessions.revokeAccountSessions({
      accountModel: req.accountModel, accountId: req.user._id, exceptId: req.session._id, reason: 'user_revoked_others', io: req.app.get('io'),
    })
    if (revoked) await recordAuthEvent('session_revoked', { req, accountModel: req.accountModel, accountId: req.user._id, email: req.user.email, detail: `${revoked} other session${revoked === 1 ? '' : 's'}` })
    res.json({ revoked })
  } catch (error) {
    handleControllerError(res, error, 'Could not sign the other sessions out')
  }
}

// Recent security events of the signed-in person's own account.
const listActivity = async (req, res) => {
  try {
    const events = await listForAccount(req.accountModel, req.user._id)
    res.set('Cache-Control', 'no-store')
    res.json({ events: events.map(eventDto) })
  } catch (error) {
    handleControllerError(res, error, 'Could not load your recent activity')
  }
}

module.exports = { listSessions, revokeOneSession, revokeOtherSessions, listActivity, eventDto }
