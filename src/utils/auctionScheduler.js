const Car = require('../models/Car')

// Finds auctions whose end time has passed but are still marked active,
// flips them to 'ended', and notifies anyone watching that auction room.
const closeExpiredAuctions = async (io) => {
  try {
    const expired = await Car.find({ status: 'active', auctionEnd: { $lte: new Date() } })
      .populate('highestBidder', 'name email')

    for (const car of expired) {
      car.status = 'ended'
      await car.save()

      if (io) {
        const reserveMet = !car.reservePrice || car.currentBid >= car.reservePrice
        io.to(car._id.toString()).emit('auction-ended', {
          carId: car._id.toString(),
          finalBid: car.currentBid,
          reserveMet,
          winner: reserveMet && car.highestBidder ? { _id: car.highestBidder._id, name: car.highestBidder.name } : null,
        })
      }
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
