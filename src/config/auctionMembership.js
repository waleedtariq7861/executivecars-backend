const positiveInteger = (value, fallback) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const AUCTION_MEMBERSHIP_PRICE = positiveInteger(process.env.AUCTION_MEMBERSHIP_PRICE, 4999)
const AUCTION_MEMBERSHIP_CURRENCY = 'PKR'
const AUCTION_MEMBERSHIP_PLAN = 'annual_auction_membership'
const AUCTION_MEMBERSHIP_DURATION_YEARS = 1
const { isDemoMode } = require('./runtime')

const demoPaymentsEnabled = () => isDemoMode() && (process.env.PAYMENT_MODE || 'demo') === 'demo'

module.exports = {
  AUCTION_MEMBERSHIP_PRICE,
  AUCTION_MEMBERSHIP_CURRENCY,
  AUCTION_MEMBERSHIP_PLAN,
  AUCTION_MEMBERSHIP_DURATION_YEARS,
  demoPaymentsEnabled,
}
