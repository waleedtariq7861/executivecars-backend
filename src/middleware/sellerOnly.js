const sellerOnly = (req, res, next) => {
  if (req.accountRole !== 'user' || !['member', 'seller'].includes(req.accountModel)) {
    return res.status(403).json({ message: 'Customer account required' })
  }
  next()
}

module.exports = sellerOnly
