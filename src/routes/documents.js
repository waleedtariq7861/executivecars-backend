const express = require('express')
const protect = require('../middleware/auth')
const { documentLimiter } = require('../middleware/rateLimits')
const {
  getBookingDocument,
  getProductReport,
  getAuctionReport,
  accessDocument,
} = require('../controllers/documentController')

const router = express.Router()

router.get('/access/:token/:fileName?', documentLimiter, accessDocument)
router.use(protect)
router.get('/bookings/:id/:kind(cnic|registration)', getBookingDocument)
router.get('/products/:id/report', getProductReport)
router.get('/auctions/:id/report', getAuctionReport)

module.exports = router
