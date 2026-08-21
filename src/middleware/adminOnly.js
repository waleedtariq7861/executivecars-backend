const adminOnly = (req, res, next) => {
  if (req.accountRole !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' })
  }
  next()
}

module.exports = adminOnly
