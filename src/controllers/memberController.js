const mongoose = require('mongoose')
const Member  = require('../models/Member')
const Bid     = require('../models/Bid')
const Car     = require('../models/Car')
const Product = require('../models/Product')
const { handleControllerError } = require('../utils/http')
const { validateProfileInput } = require('../utils/inputValidation')
const { toInspectionSafeObject } = require('../utils/inspectionReport')

const toSavedProductObject = product => toInspectionSafeObject(product, { reportPath: `/documents/products/${product._id}/report` })
const toWonAuctionObject = car => toInspectionSafeObject(car, { reportPath: `/documents/auctions/${car._id}/report` })

const requireCustomerAccount = (req, res) => {
  if (req.accountRole !== 'user' || req.accountModel !== 'member') {
    res.status(403).json({ message: 'Customer account required' })
    return false
  }
  return true
}

const getSavedCars = async (req, res) => {
  if (!requireCustomerAccount(req, res)) return
  try {
    const member = await Member.findById(req.user._id).populate({
      path: 'savedCars',
      match: { status: 'available' },
      options: { sort: { createdAt: -1 } },
    })
    res.json({ cars: (member?.savedCars || []).map(toSavedProductObject) })
  } catch (err) {
    handleControllerError(res, err, 'Could not load saved cars')
  }
}

const saveCar = async (req, res) => {
  if (!requireCustomerAccount(req, res)) return
  try {
    if (!mongoose.isValidObjectId(req.params.productId)) {
      return res.status(400).json({ message: 'Invalid car identifier' })
    }
    const product = await Product.findOne({ _id: req.params.productId, status: 'available' })
    if (!product) return res.status(404).json({ message: 'Car listing not found' })

    await Member.findByIdAndUpdate(req.user._id, { $addToSet: { savedCars: product._id } })
    res.status(201).json({ saved: true, car: toSavedProductObject(product) })
  } catch (err) {
    handleControllerError(res, err, 'Could not save car')
  }
}

const removeSavedCar = async (req, res) => {
  if (!requireCustomerAccount(req, res)) return
  try {
    if (!mongoose.isValidObjectId(req.params.productId)) {
      return res.status(400).json({ message: 'Invalid car identifier' })
    }
    await Member.findByIdAndUpdate(req.user._id, { $pull: { savedCars: req.params.productId } })
    res.json({ saved: false })
  } catch (err) {
    handleControllerError(res, err, 'Could not remove saved car')
  }
}

const getProfile = async (req, res) => {
  try {
    const member = await Member.findById(req.user._id).select('-password')
    res.json(member)
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

    const member = await Member.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true }).select('-password')
    res.json(member)
  } catch (err) {
    handleControllerError(res, err, 'Could not update profile')
  }
}

const getMyBids = async (req, res) => {
  try {
    const bids = await Bid.find({ bidderId: req.user._id })
      .populate({
        path: 'carId',
        select: 'make model year images currentBid status auctionEnd highestBidder bidCount',
        populate: { path: 'highestBidder', select: 'name' },
      })
      .sort({ createdAt: -1 })
    res.json(bids)
  } catch (err) {
    handleControllerError(res, err, 'Could not load bids')
  }
}

const getWonCars = async (req, res) => {
  try {
    const wonCars = await Car.find({
      highestBidder: req.user._id,
      status: 'ended',
      $or: [
        { reservePrice: { $exists: false } },
        { reservePrice: null },
        { $expr: { $gte: ['$currentBid', '$reservePrice'] } },
      ],
    })
    res.json(wonCars.map(toWonAuctionObject))
  } catch (err) {
    handleControllerError(res, err, 'Could not load won cars')
  }
}

const getStats = async (req, res) => {
  try {
    const [totalBids, wonCars, activeCarIds] = await Promise.all([
      Bid.countDocuments({ bidderId: req.user._id }),
      Car.countDocuments({
        highestBidder: req.user._id,
        status: 'ended',
        $or: [
          { reservePrice: { $exists: false } },
          { reservePrice: null },
          { $expr: { $gte: ['$currentBid', '$reservePrice'] } },
        ],
      }),
      Car.distinct('_id', { status: 'active', auctionStart: { $lte: new Date() }, auctionEnd: { $gt: new Date() } }),
    ])
    const activeBids = await Bid.countDocuments({ bidderId: req.user._id, carId: { $in: activeCarIds } })

    res.json({ totalBids, wonCars, activeBids })
  } catch (err) {
    handleControllerError(res, err, 'Could not load member statistics')
  }
}

module.exports = {
  getProfile,
  updateProfile,
  getMyBids,
  getWonCars,
  getStats,
  getSavedCars,
  saveCar,
  removeSavedCar,
}
