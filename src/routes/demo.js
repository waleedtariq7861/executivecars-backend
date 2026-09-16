const express = require('express')
const { isDemoMode } = require('../config/runtime')
const { demoAccounts } = require('../config/demoAccounts')

const router = express.Router()

router.get('/accounts', (req, res) => {
  if (!isDemoMode() || process.env.ENABLE_DEMO_SEED !== 'true') return res.status(404).json({ message: 'Route not found' })
  res.set('Cache-Control', 'no-store')
  const accounts = demoAccounts()
  return res.json({
    members: [
      { label: 'Premium member', email: accounts.premium.email, password: accounts.premium.password },
      { label: 'Regular user', email: accounts.regular.email, password: accounts.regular.password },
      { label: 'Auction bidder', email: accounts.bidder.email, password: accounts.bidder.password },
    ],
    admin: { label: 'Demo administrator', email: accounts.admin.email, password: accounts.admin.password },
  })
})

module.exports = router
