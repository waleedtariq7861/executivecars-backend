const { test } = require('node:test')
const assert = require('node:assert/strict')
const { getMemberAuctionState, hasMetReserve } = require('../src/utils/auctionOutcome')

const now = Date.parse('2026-10-02T12:00:00Z')
const auction = overrides => ({
  status: 'ended', reservePrice: 4000000, currentBid: 3500000,
  highestBidder: { _id: 'member-1' }, bidCount: 1,
  auctionStart: new Date(now - 60000), auctionEnd: new Date(now + 60000),
  ...overrides,
})

for (const [name, fields, expected] of [
  ['highest bidder below reserve', {}, 'unsold'],
  ['exact reserve', { currentBid: 4000000 }, 'won'],
  ['above reserve', { currentBid: 4500000 }, 'won'],
  ['absent reserve', { reservePrice: undefined }, 'won'],
  ['null reserve', { reservePrice: null }, 'won'],
  ['other winner', { currentBid: 4000000, highestBidder: { _id: 'other' } }, 'lost'],
  ['other bidder below reserve', { highestBidder: { _id: 'other' } }, 'unsold'],
  ['no bids', { currentBid: 0, highestBidder: null, bidCount: 0, reservePrice: undefined }, 'unsold'],
  ['cancelled highest bidder', { status: 'cancelled', currentBid: 4500000 }, 'cancelled'],
  ['upcoming', { status: 'active', auctionStart: new Date(now + 1000) }, 'upcoming'],
  ['expired awaiting scheduler', { status: 'active', auctionEnd: new Date(now) }, 'awaiting_result'],
  ['unknown status', { status: 'unknown' }, 'unavailable'],
  ['missing timing', { status: 'active', auctionStart: undefined }, 'unavailable'],
]) {
  test(`auction outcome: ${name}`, () => {
    assert.deepEqual(getMemberAuctionState(auction(fields), 'member-1', now), { status: expected, biddingOpen: false })
  })
}

test('only live auction windows allow bidding, including the start boundary', () => {
  assert.deepEqual(getMemberAuctionState(auction({ status: 'active', auctionStart: new Date(now) }), 'member-1', now),
    { status: 'leading', biddingOpen: true })
  assert.deepEqual(getMemberAuctionState(auction({ status: 'active', highestBidder: 'other' }), 'member-1', now),
    { status: 'outbid', biddingOpen: true })
})

test('missing auctions cannot invent a winning outcome', () => {
  assert.deepEqual(getMemberAuctionState(null, 'member-1', now), { status: 'unavailable', biddingOpen: false })
})

test('the shared reserve rule includes equality and absent reserves', () => {
  assert.equal(hasMetReserve(auction()), false)
  assert.equal(hasMetReserve(auction({ currentBid: 4000000 })), true)
  assert.equal(hasMetReserve(auction({ reservePrice: undefined })), true)
})
