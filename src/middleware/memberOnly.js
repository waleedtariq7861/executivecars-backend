const memberOnly = (req, res, next) => {
  if (req.accountRole !== 'user' || req.accountModel !== 'member') {
    return res.status(403).json({ message: 'Member access required' })
  }
  if (!req.user.hasActiveSubscription()) {
    return res.status(403).json({ message: 'Active membership required' })
  }
  next()
}

module.exports = memberOnly
