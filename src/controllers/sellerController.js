const Seller  = require('../models/Seller')
const Member  = require('../models/Member')
const Booking = require('../models/Booking')
const Car     = require('../models/Car')
const Product = require('../models/Product')
const { handleControllerError } = require('../utils/http')
const { validateProfileInput } = require('../utils/inputValidation')
const { toBookingObject } = require('../utils/bookingDto')
const { toInspectionSafeObject } = require('../utils/inspectionReport')

const toSellerAuctionObject = car => toInspectionSafeObject(car, { reportPath: `/documents/auctions/${car._id}/report` })
const toSellerProductObject = product => toInspectionSafeObject(product, { reportPath: `/documents/products/${product._id}/report` })

const ownedBy = (user) => ({
  $or: [
    { ownerId: user._id },
    {
      $and: [
        { $or: [{ ownerId: { $exists: false } }, { ownerId: null }] },
        { sellerEmail: user.email },
      ],
    },
  ],
})

const getProfile = async (req, res) => {
  try {
    const Model = req.accountModel === 'seller' ? Seller : Member
    const seller = await Model.findById(req.user._id).select('-password')
    res.json(seller)
  } catch (err) {
    handleControllerError(res, err, 'Could not load profile')
  }
}

const updateProfile = async (req, res) => {
  try {
    const { updates, errors } = validateProfileInput(req.body)
    if (Object.keys(errors).length) {
      return res.status(400).json({ message: 'Please correct the invalid profile fields.', errors })
    }
    for (const key of ['city', 'address']) {
      if (req.body[key] !== undefined) updates[key] = String(req.body[key]).trim().slice(0, key === 'city' ? 80 : 250)
    }

    const Model = req.accountModel === 'seller' ? Seller : Member
    const seller = await Model.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true }).select('-password')
    res.json(seller)
  } catch (err) {
    handleControllerError(res, err, 'Could not update profile')
  }
}

// Inspection bookings owned by this account, with email fallback for legacy rows.
const getBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({
      $or: [
        { memberId: req.user._id },
        {
          $and: [
            { $or: [{ memberId: { $exists: false } }, { memberId: null }] },
            { email: req.user.email },
          ],
        },
      ],
    }).sort({ createdAt: -1 })
    res.json(bookings.map(toBookingObject))
  } catch (err) {
    handleControllerError(res, err, 'Could not load bookings')
  }
}

// All listings (auction + used cars) linked to this seller's email
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

module.exports = { getProfile, updateProfile, getBookings, getListings, getAuctionStatus }
