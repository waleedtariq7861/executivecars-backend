const express = require('express')
const router = express.Router()
const protect    = require('../middleware/auth')
const sellerOnly = require('../middleware/sellerOnly')
const { getProfile, updateProfile, getBookings, getListings, getAuctionStatus } = require('../controllers/sellerController')

router.use(protect, sellerOnly)

router.get('/profile',         getProfile)
router.put('/profile',         updateProfile)
router.get('/bookings',        getBookings)
router.get('/listings',        getListings)
router.get('/auction-status',  getAuctionStatus)

module.exports = router
