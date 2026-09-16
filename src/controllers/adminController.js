const mongoose = require('mongoose')
const Admin   = require('../models/Admin')
const Member  = require('../models/Member')
const Booking = require('../models/Booking')
const Car     = require('../models/Car')
const Product = require('../models/Product')
const Bid     = require('../models/Bid')
const VehicleRecord = require('../models/VehicleRecord')
const { uploadedFileUrl, storedPrivateAsset, deletePrivateAsset } = require('../config/cloudinary')
const { escapeRegex, handleControllerError, pick } = require('../utils/http')
const { strictNumber } = require('../utils/inputValidation')
const { toInspectionSafeObject } = require('../utils/inspectionReport')
const { toBookingObject } = require('../utils/bookingDto')

const toAdminAuctionObject = car => toInspectionSafeObject(car, { reportPath: `/documents/auctions/${car._id}/report` })
const toAdminProductObject = product => toInspectionSafeObject(product, { reportPath: `/documents/products/${product._id}/report` })

const AUCTION_UPDATE_FIELDS = [
  'make', 'model', 'variant', 'year', 'km', 'engine', 'fuel', 'transmission', 'color',
  'city', 'registrationCity', 'bodyType', 'assemblyType', 'condition',
  'verificationStatus', 'reservePrice',
  'basePrice', 'auctionStart', 'auctionEnd', 'description', 'status', 'ownerId',
]
const PRODUCT_UPDATE_FIELDS = [
  'make', 'model', 'variant', 'year', 'km', 'price', 'engine', 'fuel', 'transmission',
  'color', 'city', 'registrationCity', 'bodyType', 'assemblyType', 'condition',
  'verificationStatus', 'description', 'status', 'ownerId',
]

const numericField = (name, value, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  strictNumber(name, value, { min, max, integer: true })

const dateField = (name, value) => {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${name} must be a valid date and time`)
    error.status = 400
    throw error
  }
  return parsed
}

const requireFields = (payload, fields) => {
  const missing = fields.filter(field => payload[field] === undefined || payload[field] === null || String(payload[field]).trim() === '')
  if (missing.length) {
    const error = new Error(`Missing required fields: ${missing.join(', ')}`)
    error.status = 400
    throw error
  }
}

const resolveOwner = async (ownerId) => {
  if (!ownerId) return { ownerId: null, sellerEmail: '' }

  if (!mongoose.isValidObjectId(ownerId)) {
    const error = new Error('Selected listing owner is invalid')
    error.status = 400
    throw error
  }

  const owner = await Member.findById(ownerId).select('_id email')
  if (!owner) {
    const error = new Error('Selected listing owner does not exist')
    error.status = 400
    throw error
  }

  return { ownerId: owner._id, sellerEmail: owner.email }
}

// ── Dashboard ────────────────────────────────────────────────────────────────
const getStats = async (req, res) => {
  try {
    const [totalMembers, totalBookings, liveAuctions, usedCarsListed, verifiedCars, pendingInspections, importedDatasetRows, totalBids] = await Promise.all([
      Member.countDocuments(),
      Booking.countDocuments(),
      Car.countDocuments({ status: 'active', auctionStart: { $lte: new Date() }, auctionEnd: { $gt: new Date() } }),
      Product.countDocuments({ status: 'available' }),
      Product.countDocuments({ status: 'available', verificationStatus: 'verified' }),
      Booking.countDocuments({ status: 'pending' }),
      VehicleRecord.countDocuments(),
      Bid.countDocuments(),
    ])
    const recentBookings = await Booking.find().sort({ createdAt: -1 }).limit(5)
    const liveAuctionList = await Car.find({ status: 'active', auctionStart: { $lte: new Date() }, auctionEnd: { $gt: new Date() } })
      .sort({ auctionEnd: 1 })
      .limit(5)
      .populate('highestBidder', 'name email')

    res.json({
      totalMembers, totalBookings, liveAuctions, usedCarsListed, verifiedCars, pendingInspections, importedDatasetRows, totalBids,
      recentBookings: recentBookings.map(toBookingObject),
      liveAuctionList: liveAuctionList.map(toAdminAuctionObject),
    })
  } catch (err) {
    handleControllerError(res, err, 'Could not load dashboard statistics')
  }
}

// ── Bookings ─────────────────────────────────────────────────────────────────
const getBookings = async (req, res) => {
  try {
    const { status, search } = req.query
    const filter = {}
    if (status) filter.status = status
    if (search) {
      const matcher = new RegExp(escapeRegex(search), 'i')
      filter.$or = [
        { name: matcher },
        { email: matcher },
        { carMake: matcher },
      ]
    }
    const bookings = await Booking.find(filter).sort({ createdAt: -1 })
    res.json(bookings.map(toBookingObject))
  } catch (err) {
    handleControllerError(res, err, 'Could not load bookings')
  }
}

const updateBookingStatus = async (req, res) => {
  try {
    const { status } = req.body
    if (!['approved', 'rejected', 'confirmed', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ message: 'Status must be approved, rejected, confirmed, completed, or cancelled' })
    }

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ message: 'Booking not found' })

    booking.status = status
    await booking.save()

    // Bookings can only be created by an authenticated member, so approval never
    // needs to create or disclose a separate seller password.
    if (status === 'approved' && !booking.sellerCreated) {
      const account = await Member.findOne({ email: booking.email })
      if (!account) {
        return res.status(409).json({ message: 'The booking owner account no longer exists and cannot be approved.' })
      }
      account.sellerApproved = true
      account.sellerBookingId = booking._id
      account.phone = account.phone || booking.phone
      account.cnic = account.cnic || booking.cnic
      await account.save()
      booking.sellerCreated = true
      await booking.save()
    }

    res.json({ message: `Booking ${status}`, booking: toBookingObject(booking) })
  } catch (err) {
    handleControllerError(res, err, 'Could not update booking')
  }
}

const deleteBooking = async (req, res) => {
  try {
    const booking = await Booking.findByIdAndDelete(req.params.id)
    if (!booking) return res.status(404).json({ message: 'Booking not found' })
    await Promise.all([deletePrivateAsset(booking.cnicDocument), deletePrivateAsset(booking.registrationDocument)])
    res.json({ message: 'Booking deleted' })
  } catch (err) {
    handleControllerError(res, err, 'Could not delete booking')
  }
}

// ── Members ──────────────────────────────────────────────────────────────────
const getMembers = async (req, res) => {
  try {
    await Member.updateMany(
      { subscriptionStatus: 'active', subscriptionExpiry: { $lte: new Date() } },
      { $set: { subscriptionStatus: 'expired' } }
    )
    const { search, status, page = 1, limit = 20 } = req.query
    const filter = {}
    if (status) filter.subscriptionStatus = status
    if (search) {
      const matcher = new RegExp(escapeRegex(search), 'i')
      filter.$or = [{ name: matcher }, { email: matcher }]
    }
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1)
    const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 20))
    const total = await Member.countDocuments(filter)
    const members = await Member.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)

    res.json({ total, page: safePage, limit: safeLimit, members })
  } catch (err) {
    handleControllerError(res, err, 'Could not load members')
  }
}

const deleteMember = async (req, res) => {
  try {
    const member = await Member.findById(req.params.id)
    if (!member) return res.status(404).json({ message: 'Member not found' })
    if (await Bid.exists({ bidderId: member._id })) {
      return res.status(409).json({ message: 'This member has auction history and cannot be deleted' })
    }
    await Promise.all([
      Car.updateMany({ ownerId: req.params.id }, { $unset: { ownerId: 1 }, $set: { sellerEmail: '' } }),
      Product.updateMany({ ownerId: req.params.id }, { $unset: { ownerId: 1 }, $set: { sellerEmail: '' } }),
    ])
    await member.deleteOne()
    res.json({ message: 'Member deleted' })
  } catch (err) {
    handleControllerError(res, err, 'Could not delete member')
  }
}

// ── Auction Cars ─────────────────────────────────────────────────────────────
const createCar = async (req, res) => {
  try {
    const { make, model, variant, year, km, engine, fuel, transmission, color, city, registrationCity, bodyType, assemblyType, condition, basePrice, reservePrice, auctionStart, auctionEnd, description, ownerId } = req.body
    requireFields(req.body, ['make', 'model', 'year', 'km', 'engine', 'basePrice', 'auctionStart', 'auctionEnd'])

    const images = req.files?.images?.map(file => uploadedFileUrl(req, file)) || []
    const inspectionDocument = storedPrivateAsset(req.files?.report?.[0])
    const ownership = await resolveOwner(ownerId)
    const start = dateField('Auction start', auctionStart)
    const end = dateField('Auction end', auctionEnd)
    if (end <= start || end <= new Date()) {
      return res.status(400).json({ message: 'Auction end time must be after the start time and in the future' })
    }
    const price = numericField('Base price', basePrice, 1)
    const engineCC = numericField('Engine capacity', engine, 1, 10000)

    const car = await Car.create({
      make, model, variant, year: numericField('Year', year, 1900, new Date().getFullYear() + 1), km: numericField('Mileage', km, 0, 1000000), engine: String(engineCC), fuel, transmission, color,
      city, registrationCity, bodyType, assemblyType, condition,
      basePrice: price, currentBid: price,
      reservePrice: reservePrice ? numericField('Reserve price', reservePrice, 1) : undefined,
      auctionStart: start, auctionEnd: end,
      description, images, inspectionDocument,
      inspectionStatus: inspectionDocument ? 'report_available' : 'not_available',
      ...ownership,
    })

    await car.populate('ownerId', 'name email sellerApproved')
    res.status(201).json(toAdminAuctionObject(car))
  } catch (err) {
    handleControllerError(res, err, 'Could not create auction')
  }
}

const getAdminCars = async (req, res) => {
  try {
    const cars = await Car.find().sort({ createdAt: -1 }).populate('ownerId', 'name email sellerApproved')
    res.json(cars.map(toAdminAuctionObject))
  } catch (err) {
    handleControllerError(res, err, 'Could not load auctions')
  }
}

const updateCar = async (req, res) => {
  try {
    const car = await Car.findById(req.params.id)
    if (!car) return res.status(404).json({ message: 'Car not found' })
    const updates = pick(req.body, AUCTION_UPDATE_FIELDS)
    if (Object.prototype.hasOwnProperty.call(updates, 'year')) updates.year = numericField('Year', updates.year, 1900, new Date().getFullYear() + 1)
    if (Object.prototype.hasOwnProperty.call(updates, 'km')) updates.km = numericField('Mileage', updates.km, 0, 1000000)
    if (Object.prototype.hasOwnProperty.call(updates, 'engine')) updates.engine = String(numericField('Engine capacity', updates.engine, 1, 10000))
    if (Object.prototype.hasOwnProperty.call(updates, 'basePrice')) updates.basePrice = numericField('Base price', updates.basePrice, 1)
    if (Object.prototype.hasOwnProperty.call(updates, 'reservePrice')) updates.reservePrice = numericField('Reserve price', updates.reservePrice, 1)
    if (Object.prototype.hasOwnProperty.call(updates, 'auctionStart')) updates.auctionStart = dateField('Auction start', updates.auctionStart)
    if (Object.prototype.hasOwnProperty.call(updates, 'auctionEnd')) updates.auctionEnd = dateField('Auction end', updates.auctionEnd)
    if (Object.prototype.hasOwnProperty.call(updates, 'ownerId')) {
      Object.assign(updates, await resolveOwner(updates.ownerId))
    }
    const nextStart = updates.auctionStart || car.auctionStart
    const nextEnd = updates.auctionEnd || car.auctionEnd
    if (nextEnd <= nextStart) return res.status(400).json({ message: 'Auction end time must be after the start time' })
    if (updates.basePrice && car.bidCount === 0) updates.currentBid = updates.basePrice

    Object.assign(car, updates)
    await car.save()
    await car.populate('ownerId', 'name email sellerApproved')
    res.json(toAdminAuctionObject(car))
  } catch (err) {
    handleControllerError(res, err, 'Could not update auction')
  }
}

const deleteCar = async (req, res) => {
  try {
    const car = await Car.findByIdAndDelete(req.params.id)
    if (!car) return res.status(404).json({ message: 'Car not found' })
    await Promise.all([Bid.deleteMany({ carId: req.params.id }), deletePrivateAsset(car.inspectionDocument)])
    res.json({ message: 'Car and related bids deleted' })
  } catch (err) {
    handleControllerError(res, err, 'Could not delete auction')
  }
}

const getAuctionResult = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid auction identifier' })
    const auction = await Car.findById(req.params.id).populate('highestBidder', 'name email')
    if (!auction) return res.status(404).json({ message: 'Auction not found' })
    const bids = await Bid.find({ carId: auction._id }).sort({ createdAt: -1 }).populate('bidderId', 'name email')
    const reserveMet = !auction.reservePrice || auction.currentBid >= auction.reservePrice
    const winner = reserveMet && auction.highestBidder
      ? { _id: auction.highestBidder._id, name: auction.highestBidder.name, email: auction.highestBidder.email }
      : null
    res.json({ auction: toAdminAuctionObject(auction), bids, reserveMet, winner })
  } catch (err) {
    handleControllerError(res, err, 'Could not load auction results')
  }
}

const closeAuction = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid auction identifier' })
    const auction = await Car.findOneAndUpdate(
      { _id: req.params.id, status: 'active' },
      { $set: { status: 'ended' } },
      { new: true, runValidators: true },
    ).populate('highestBidder', 'name email')
    if (!auction) return res.status(409).json({ message: 'Auction is already closed or does not exist' })
    const reserveMet = !auction.reservePrice || auction.currentBid >= auction.reservePrice
    const io = req.app.get('io')
    io?.to(auction._id.toString()).emit('auction-ended', {
      carId: auction._id.toString(), finalBid: auction.currentBid,
      reserveMet,
      winner: reserveMet && auction.highestBidder ? { _id: auction.highestBidder._id, name: auction.highestBidder.name } : null,
    })
    res.json({ message: 'Auction closed', auction: toAdminAuctionObject(auction), reserveMet })
  } catch (err) {
    handleControllerError(res, err, 'Could not close auction')
  }
}

// ── Used Car Products ─────────────────────────────────────────────────────────
const createProduct = async (req, res) => {
  try {
    const { make, model, variant, year, km, price, engine, fuel, transmission, color, city, registrationCity, bodyType, assemblyType, condition, description, ownerId } = req.body
    requireFields(req.body, ['make', 'model', 'year', 'km', 'price'])

    const images = req.files?.images?.map(file => uploadedFileUrl(req, file)) || []
    const inspectionDocument = storedPrivateAsset(req.files?.report?.[0])
    const ownership = await resolveOwner(ownerId)

    const product = await Product.create({
      make, model, variant, year: numericField('Year', year, 1900, new Date().getFullYear() + 1), km: numericField('Mileage', km, 0, 1000000), price: numericField('Price', price, 1),
      engine: engine ? String(numericField('Engine capacity', engine, 1, 10000)) : '', fuel, transmission, color, city, registrationCity, bodyType, assemblyType, condition,
      description, images, inspectionDocument,
      inspectionStatus: inspectionDocument ? 'report_available' : 'not_available',
      ...ownership,
    })

    await product.populate('ownerId', 'name email sellerApproved')
    res.status(201).json(toAdminProductObject(product))
  } catch (err) {
    handleControllerError(res, err, 'Could not create used-car listing')
  }
}

const getAdminProducts = async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 }).populate('ownerId', 'name email sellerApproved')
    res.json(products.map(toAdminProductObject))
  } catch (err) {
    handleControllerError(res, err, 'Could not load used-car listings')
  }
}

const updateProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Product not found' })
    const updates = pick(req.body, PRODUCT_UPDATE_FIELDS)
    if (Object.prototype.hasOwnProperty.call(updates, 'year')) updates.year = numericField('Year', updates.year, 1900, new Date().getFullYear() + 1)
    if (Object.prototype.hasOwnProperty.call(updates, 'km')) updates.km = numericField('Mileage', updates.km, 0, 1000000)
    if (Object.prototype.hasOwnProperty.call(updates, 'price')) updates.price = numericField('Price', updates.price, 1)
    if (Object.prototype.hasOwnProperty.call(updates, 'engine') && updates.engine) updates.engine = String(numericField('Engine capacity', updates.engine, 1, 10000))
    if (Object.prototype.hasOwnProperty.call(updates, 'ownerId')) {
      Object.assign(updates, await resolveOwner(updates.ownerId))
    }

    Object.assign(product, updates)
    await product.save()
    await product.populate('ownerId', 'name email sellerApproved')
    res.json(toAdminProductObject(product))
  } catch (err) {
    handleControllerError(res, err, 'Could not update used-car listing')
  }
}

const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id)
    if (!product) return res.status(404).json({ message: 'Product not found' })
    await deletePrivateAsset(product.inspectionDocument)
    res.json({ message: 'Product deleted' })
  } catch (err) {
    handleControllerError(res, err, 'Could not delete used-car listing')
  }
}

module.exports = {
  getStats,
  getBookings, updateBookingStatus, deleteBooking,
  getMembers, deleteMember,
  createCar, getAdminCars, updateCar, deleteCar, getAuctionResult, closeAuction,
  createProduct, getAdminProducts, updateProduct, deleteProduct,
}
