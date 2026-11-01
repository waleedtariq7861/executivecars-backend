const positiveInteger = (value, fallback) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const AUCTION_MEMBERSHIP_PRICE = positiveInteger(process.env.AUCTION_MEMBERSHIP_PRICE, 4999)
const AUCTION_MEMBERSHIP_CURRENCY = 'PKR'
const AUCTION_MEMBERSHIP_PLAN = 'annual_auction_membership'
const AUCTION_MEMBERSHIP_NAME = 'Annual Auction Membership'
const AUCTION_MEMBERSHIP_DURATION_YEARS = 1

// What the customer is buying. The price is read on the server when a payment is created; the browser never supplies it.
const membershipPlan = () => ({
  id: AUCTION_MEMBERSHIP_PLAN,
  name: AUCTION_MEMBERSHIP_NAME,
  amount: AUCTION_MEMBERSHIP_PRICE,
  currency: AUCTION_MEMBERSHIP_CURRENCY,
  durationYears: AUCTION_MEMBERSHIP_DURATION_YEARS,
})

module.exports = {
  AUCTION_MEMBERSHIP_PRICE,
  AUCTION_MEMBERSHIP_CURRENCY,
  AUCTION_MEMBERSHIP_PLAN,
  AUCTION_MEMBERSHIP_NAME,
  AUCTION_MEMBERSHIP_DURATION_YEARS,
  membershipPlan,
}
