// Keep bid-history outcomes aligned with the reserve rule used by auction results.
const hasMetReserve = car => !car.reservePrice || car.currentBid >= car.reservePrice

const wonAuctionFilter = memberId => ({
  highestBidder: memberId,
  status: 'ended',
  $or: [
    { reservePrice: { $exists: false } },
    { reservePrice: null },
    { $expr: { $gte: ['$currentBid', '$reservePrice'] } },
  ],
})

// biddingOpen describes the auction's time window, not account authorization.
// The bid endpoint continues to enforce membership and ownership restrictions.
const getMemberAuctionState = (car, memberId, now = Date.now()) => {
  const closed = status => ({ status, biddingOpen: false })
  if (!car) return closed('unavailable')
  if (car.status === 'cancelled') return closed('cancelled')

  const highestBidderId = car.highestBidder?._id || car.highestBidder
  const isLeading = Boolean(highestBidderId && memberId && String(highestBidderId) === String(memberId))
  if (car.status === 'ended') {
    if (!highestBidderId || !hasMetReserve(car)) return closed('unsold')
    return closed(isLeading ? 'won' : 'lost')
  }
  if (car.status !== 'active') return closed('unavailable')

  const startsAt = new Date(car.auctionStart).getTime()
  const endsAt = new Date(car.auctionEnd).getTime()
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) return closed('unavailable')
  if (now >= endsAt) return closed('awaiting_result')
  if (now < startsAt) return closed('upcoming')
  return { status: isLeading ? 'leading' : 'outbid', biddingOpen: true }
}

module.exports = { hasMetReserve, wonAuctionFilter, getMemberAuctionState }
