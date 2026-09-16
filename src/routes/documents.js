const express = require('express')
const protect = require('../middleware/auth')
const {
  getBookingDocument,
  getProductReport,
  getAuctionReport,
  accessLocalDocument,
} = require('../controllers/documentController')

const router = express.Router()

router.get('/access/:token', accessLocalDocument)
router.use(protect)
router.get('/bookings/:id/:kind(cnic|registration)', getBookingDocument)
router.get('/products/:id/report', getProductReport)
router.get('/auctions/:id/report', getAuctionReport)

module.exports = router
