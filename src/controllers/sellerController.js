const Booking = require('../models/Booking')
const Car     = require('../models/Car')
const Product = require('../models/Product')
const { handleControllerError } = require('../utils/http')
const { toBookingObject } = require('../utils/bookingDto')
const { toInspectionSafeObject } = require('../utils/inspectionReport')

const toSellerAuctionObject = car => toInspectionSafeObject(car, { reportPath: `/documents/auctions/${car._id}/report` })
const toSellerProductObject = product => toInspectionSafeObject(product, { reportPath: `/documents/products/${product._id}/report` })

const ownedBy = user => ({ ownerId: user._id })

// Inspection bookings owned by this account.
const getBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ memberId: req.user._id }).sort({ createdAt: -1 })
    res.json(bookings.map(toBookingObject))
  } catch (err) {
    handleControllerError(res, err, 'Could not load bookings')
  }
}

// All listings (auction + used cars) assigned to this account
const getListings = async (req, res) => {
  try {
    const [auctionCars, usedCars] = await Promise.all([
      Car.find(ownedBy(req.user)),
      Product.find(ownedBy(req.user)),
    ])
    res.json({
      auctionCars: auctionCars.map(toSellerAuctionObject),
      usedCars: usedCars.map(toSellerProductObject),
    })
  } catch (err) {
    handleControllerError(res, err, 'Could not load listings')
  }
}

// Current auction status for all of this seller's cars in auction
const getAuctionStatus = async (req, res) => {
  try {
    const cars = await Car.find(ownedBy(req.user))
      .sort({ createdAt: -1 })
      .populate('highestBidder', 'name')
    res.json(cars.map(toSellerAuctionObject))
  } catch (err) {
    handleControllerError(res, err, 'Could not load auction status')
  }
}

module.exports = { getBookings, getListings, getAuctionStatus }
