const { hasMetReserve } = require('./auctionOutcome')
const { maskBidderName } = require('./publicDto')

const idOf = value => String(value?._id || value || '')

// Live auction messages go to everyone watching a room, so they carry no name or account id of a bidder.
// The bidder is told separately, in their own room, that the result is theirs; everybody else gets a masked name.
// (Hiding a name in the browser would not help: the browser has already received it.)

/** A new highest bid. `bidder` is the account that placed it. */
const emitBidUpdate = (io, { carId, bidAmount, bidder, bidCount }) => {
  if (!io) return
  const shared = { carId, currentBid: bidAmount, bidCount }
  const personalRoom = `user-${idOf(bidder)}`
  io.to(personalRoom).emit('bid-update', { ...shared, highestBidder: { isMe: true, name: 'You' } })
  io.to(carId).except(personalRoom).emit('bid-update', { ...shared, highestBidder: { name: maskBidderName(bidder.name) } })
}

/** The close of an auction. A winner is named only when the reserve was met and someone bid. */
const emitAuctionEnded = (io, car) => {
  if (!io) return
  const carId = String(car._id)
  const reserveMet = hasMetReserve(car)
  const shared = { carId, finalBid: car.currentBid, reserveMet }
  const winner = reserveMet && car.highestBidder ? car.highestBidder : null
  if (!winner) {
    io.to(carId).emit('auction-ended', { ...shared, winner: null })
    return
  }
  const personalRoom = `user-${idOf(winner)}`
  io.to(personalRoom).emit('auction-ended', { ...shared, winner: { isMe: true, name: 'You' } })
  io.to(carId).except(personalRoom).emit('auction-ended', { ...shared, winner: { name: maskBidderName(winner.name) } })
}

module.exports = { emitBidUpdate, emitAuctionEnded }
