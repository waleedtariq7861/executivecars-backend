const express = require('express')
const router = express.Router()
const protect    = require('../middleware/auth')
const memberOnly = require('../middleware/memberOnly')
const {
  getProfile,
  updateProfile,
  getMyBids,
  getWonCars,
  getStats,
  getSavedCars,
  saveCar,
  removeSavedCar,
} = require('../controllers/memberController')

// Saved cars belong to every signed-in customer; auction membership is not required.
router.get('/saved-cars', protect, getSavedCars)
router.post('/saved-cars/:productId', protect, saveCar)
router.delete('/saved-cars/:productId', protect, removeSavedCar)

// Account/profile management is available to every signed-in customer;
// auction data below still requires an active membership.
router.get('/profile',  protect, getProfile)
router.put('/profile',  protect, updateProfile)
router.get('/bids',     protect, memberOnly, getMyBids)
router.get('/won',      protect, memberOnly, getWonCars)
router.get('/stats',    protect, memberOnly, getStats)

module.exports = router
