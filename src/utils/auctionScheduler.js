const Car = require('../models/Car')
const { emitAuctionEnded } = require('./auctionEvents')

// Finds auctions whose end time has passed but are still marked active,
// flips them to 'ended', and notifies anyone watching that auction room.
const closeExpiredAuctions = async (io) => {
  try {
    const expired = await Car.find({ status: 'active', auctionEnd: { $lte: new Date() } })
      .populate('highestBidder', 'name email')

    for (const car of expired) {
      car.status = 'ended'
      await car.save()

      emitAuctionEnded(io, car)
    }

    return expired.length
  } catch (err) {
    console.error('Auction scheduler error:', err.message)
    return 0
  }
}

const startAuctionScheduler = (io, intervalMs = 60 * 1000) => {
  closeExpiredAuctions(io)
  const timer = setInterval(() => closeExpiredAuctions(io), intervalMs)
  timer.unref?.()
  return timer
}

module.exports = { closeExpiredAuctions, startAuctionScheduler }
