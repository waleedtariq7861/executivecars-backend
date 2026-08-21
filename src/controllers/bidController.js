const Bid = require('../models/Bid')
const Car = require('../models/Car')
const mongoose = require('mongoose')
const { handleControllerError } = require('../utils/http')
const { strictNumber } = require('../utils/inputValidation')

const placeBid = async (req, res) => {
  try {
    const { carId, amount } = req.body
    let bidAmount
    try {
      bidAmount = strictNumber('Bid amount', amount, { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true })
    } catch {
      return res.status(400).json({ message: 'A valid carId and positive whole-number bid amount are required' })
    }
    if (!mongoose.isValidObjectId(carId)) {
      return res.status(400).json({ message: 'A valid carId and positive bid amount are required' })
    }

    const current = await Car.findById(carId)
    if (!current) return res.status(404).json({ message: 'Car not found' })
    const now = new Date()
    if (current.status !== 'active') return res.status(400).json({ message: 'Auction is not active' })
    if (now < current.auctionStart) return res.status(400).json({ message: 'Auction has not started yet' })
    if (now >= current.auctionEnd) return res.status(400).json({ message: 'Auction has ended' })
    if (current.ownerId?.toString() === req.user._id.toString() || (current.sellerEmail && current.sellerEmail === req.user.email)) {
      return res.status(403).json({ message: 'You cannot bid on your own vehicle' })
    }

    const minimumBidIncrement = current.minimumBidIncrement || 50000
    const minBid = current.currentBid + minimumBidIncrement
    if (bidAmount < minBid) {
      return res.status(400).json({ message: `Minimum bid is PKR ${minBid.toLocaleString()}` })
    }

    // The current-bid condition makes concurrent bids atomic: a stale lower bid
    // cannot overwrite a higher bid that was accepted milliseconds earlier.
    const previous = await Car.findOneAndUpdate(
      {
        _id: carId,
        status: 'active',
        auctionStart: { $lte: now },
        auctionEnd: { $gt: now },
        currentBid: { $lte: bidAmount - minimumBidIncrement },
      },
      {
        $set: { currentBid: bidAmount, highestBidder: req.user._id },
        $inc: { bidCount: 1 },
      },
      { new: false, runValidators: true }
    )

    if (!previous) {
      const latest = await Car.findById(carId).select('currentBid minimumBidIncrement status auctionStart auctionEnd')
      if (!latest || latest.status !== 'active' || now >= latest.auctionEnd) {
        return res.status(400).json({ message: 'Auction has ended' })
      }
      return res.status(409).json({ message: `Another bid was placed first. Minimum bid is now PKR ${(latest.currentBid + (latest.minimumBidIncrement || 50000)).toLocaleString()}` })
    }

    try {
      await Bid.create({ carId, bidderId: req.user._id, amount: bidAmount })
    } catch (bidError) {
      await Car.findOneAndUpdate(
        { _id: carId, currentBid: bidAmount, highestBidder: req.user._id, bidCount: (previous.bidCount || 0) + 1 },
        { $set: { currentBid: previous.currentBid, highestBidder: previous.highestBidder || null }, $inc: { bidCount: -1 } }
      )
      throw bidError
    }

    const bidCount = (previous.bidCount || 0) + 1
    const previousHighest = previous.highestBidder

    // Emit Socket.io event — io is attached to app in server.js
    const io = req.app.get('io')
    if (io) {
      io.to(carId).emit('bid-update', {
        carId,
        currentBid:    bidAmount,
        highestBidder: { _id: req.user._id, name: req.user.name },
        bidCount,
      })

      // Notify previous highest bidder they've been outbid
      if (previousHighest && previousHighest.toString() !== req.user._id.toString()) {
        io.to(`user-${previousHighest}`).emit('outbid', { carId, newBid: bidAmount })
      }
    }

    res.status(201).json({ message: 'Bid placed successfully', currentBid: bidAmount, bidCount })
  } catch (err) {
    handleControllerError(res, err, 'Could not place bid')
  }
}

const getBidHistory = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.carId)) return res.status(400).json({ message: 'Invalid auction identifier' })
    const car = await Car.findById(req.params.carId).select('_id')
    if (!car) return res.status(404).json({ message: 'Auction not found' })

    const bids = await Bid.find({ carId: car._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('bidderId', 'name')

    res.json(bids.map(bid => {
      const isMe = bid.bidderId?._id?.toString() === req.user._id.toString()
      const name = bid.bidderId?.name || 'Member'
      return {
        id: bid._id,
        amount: bid.amount,
        createdAt: bid.createdAt,
        isMe,
        bidder: isMe ? 'You' : `${name.slice(0, 2)}***`,
      }
    }))
  } catch (error) {
    handleControllerError(res, error, 'Could not load bid history')
  }
}

module.exports = { placeBid, getBidHistory }
