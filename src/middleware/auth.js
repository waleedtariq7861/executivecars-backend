const jwt = require('jsonwebtoken')
const Admin  = require('../models/Admin')
const Member = require('../models/Member')
const Seller = require('../models/Seller')

const protect = async (req, res, next) => {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ message: 'Not authenticated' })

  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET)
    let user = null

    if (decoded.role === 'admin') {
      user = await Admin.findById(decoded.id).select('-password')
      req.accountRole = 'admin'
      req.accountModel = 'admin'
    } else if (decoded.role === 'user' || decoded.role === 'buyer') {
      user = await Member.findById(decoded.id).select('-password')
      req.accountRole = 'user'
      req.accountModel = 'member'
    } else if (decoded.role === 'seller') {
      user = await Seller.findById(decoded.id).select('-password')
      req.accountRole = 'user'
      req.accountModel = 'seller'
    }

    if (!user) return res.status(401).json({ message: 'User not found' })
    req.user = user
    next()
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' })
  }
}

module.exports = protect
