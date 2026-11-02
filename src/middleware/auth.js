const Admin  = require('../models/Admin')
const Member = require('../models/Member')
const { sessionTokenFromRequest } = require('../utils/session')
const sessions = require('../utils/sessions')

const ACCOUNT_MODELS = { member: Member, admin: Admin }

// Browsers authenticate with the HttpOnly session cookie; there is no other way in.

const reject = (res, code, message = sessions.MESSAGES[code]) => res.status(401).json({ message, code })

const protect = async (req, res, next) => {
  try {
    const { session, code } = await sessions.findValidSession(sessionTokenFromRequest(req))
    if (!session) return reject(res, code)

    const user = await ACCOUNT_MODELS[session.accountModel]?.findById(session.accountId).select('-password')
    if (!user) {
      await sessions.revokeSession(session, 'account_missing')
      return reject(res, sessions.CODES.missing, 'User not found')
    }

    req.user = user
    req.session = session
    req.accountRole = session.role
    req.accountModel = session.accountModel
    return next()
  } catch (error) {
    return next(error)
  }
}

module.exports = protect
