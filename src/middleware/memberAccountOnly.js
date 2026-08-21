const memberAccountOnly = (req, res, next) => {
  if (req.accountRole !== 'user' || req.accountModel !== 'member') {
    return res.status(403).json({ message: 'Member account required' })
  }
  next()
}

module.exports = memberAccountOnly
