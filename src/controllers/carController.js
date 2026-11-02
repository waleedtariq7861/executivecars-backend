const Car = require('../models/Car')
const { escapeRegex, handleControllerError, oneOf, queryText } = require('../utils/http')
const { toMemberAuctionObject } = require('../utils/publicDto')

const CAR_STATUSES = ['active', 'ended', 'cancelled']

const getCars = async (req, res) => {
  try {
    // An empty status means "any status" (the ended list asks for that); a missing one means active auctions.
    const status = req.query.status === undefined ? 'active' : oneOf(req.query.status, CAR_STATUSES, 'status')
    const make = queryText(req.query.make, 'make')
    const search = queryText(req.query.search, 'search')
    const phase = queryText(req.query.phase, 'phase') || 'live'
    const filter = {}
    if (status) filter.status = status
    if (phase === 'live' && status === 'active') {
      filter.auctionStart = { $lte: new Date() }
      filter.auctionEnd = { $gt: new Date() }
    } else if (phase === 'upcoming') {
      filter.status = 'active'
      filter.auctionStart = { $gt: new Date() }
    } else if (phase === 'ended') {
      filter.$or = [{ status: 'ended' }, { auctionEnd: { $lte: new Date() } }]
      delete filter.status
    } else if (phase !== 'all') {
      return res.status(400).json({ message: 'Phase must be live, upcoming, ended, or all' })
    }
    if (make) filter.make = new RegExp(escapeRegex(make), 'i')
    if (search) {
      const matcher = new RegExp(escapeRegex(search), 'i')
      const searchConditions = [{ make: matcher }, { model: matcher }]
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchConditions }]
        delete filter.$or
      } else {
        filter.$or = searchConditions
      }
    }

    const sort = phase === 'ended' ? { auctionEnd: -1 } : phase === 'upcoming' ? { auctionStart: 1 } : { auctionEnd: 1 }
    const cars = await Car.find(filter).sort(sort).populate('highestBidder', 'name')
    res.json(cars.map(car => toMemberAuctionObject(car, req.user._id)))
  } catch (err) {
    handleControllerError(res, err, 'Could not load auctions')
  }
}

const getCarById = async (req, res) => {
  try {
    const car = await Car.findById(req.params.id).populate('highestBidder', 'name')
    if (!car) return res.status(404).json({ message: 'Car not found' })
    res.json(toMemberAuctionObject(car, req.user._id))
  } catch (err) {
    handleControllerError(res, err, 'Could not load auction')
  }
}

module.exports = { getCars, getCarById, toMemberAuctionObject }
