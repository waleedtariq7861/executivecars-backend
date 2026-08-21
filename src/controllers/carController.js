const Car = require('../models/Car')
const { escapeRegex, handleControllerError } = require('../utils/http')

const getCars = async (req, res) => {
  try {
    const { make, status = 'active', search, phase = 'live' } = req.query
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
    const cars = await Car.find(filter).sort(sort)
    res.json(cars)
  } catch (err) {
    handleControllerError(res, err, 'Could not load auctions')
  }
}

const getCarById = async (req, res) => {
  try {
    const car = await Car.findById(req.params.id).populate('highestBidder', 'name')
    if (!car) return res.status(404).json({ message: 'Car not found' })
    res.json(car)
  } catch (err) {
    handleControllerError(res, err, 'Could not load auction')
  }
}

module.exports = { getCars, getCarById }
