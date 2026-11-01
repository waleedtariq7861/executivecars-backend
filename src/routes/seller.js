const express = require('express')
const router = express.Router()
const protect    = require('../middleware/auth')
const memberAccountOnly = require('../middleware/memberAccountOnly')
const { getBookings, getListings, getAuctionStatus } = require('../controllers/sellerController')

router.use(protect, memberAccountOnly)

router.get('/bookings',        getBookings)
router.get('/listings',        getListings)
router.get('/auction-status',  getAuctionStatus)

module.exports = router
