const positiveInteger = (value, fallback) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const AUCTION_MEMBERSHIP_PRICE = positiveInteger(process.env.AUCTION_MEMBERSHIP_PRICE, 4999)
const AUCTION_MEMBERSHIP_CURRENCY = 'PKR'
const AUCTION_MEMBERSHIP_PLAN = 'annual_auction_membership'
const AUCTION_MEMBERSHIP_DURATION_YEARS = 1
const { appMode, isDemoMode } = require('./runtime')

const demoPaymentsEnabled = (env = process.env) =>
  (isDemoMode(env) && (env.PAYMENT_MODE || 'demo') === 'demo') ||
  (env.NODE_ENV === 'production' && appMode(env) === 'production' &&
    env.PAYMENT_MODE === 'disabled' && env.ENABLE_HOSTED_DEMO_MEMBERSHIP === 'true')

const membershipCapabilities = () => ({
  activationMode: demoPaymentsEnabled() ? 'demo' : 'unavailable',
  amount: AUCTION_MEMBERSHIP_PRICE,
  currency: AUCTION_MEMBERSHIP_CURRENCY,
  plan: AUCTION_MEMBERSHIP_PLAN,
  durationYears: AUCTION_MEMBERSHIP_DURATION_YEARS,
})

module.exports = {
  AUCTION_MEMBERSHIP_PRICE,
  AUCTION_MEMBERSHIP_CURRENCY,
  AUCTION_MEMBERSHIP_PLAN,
  AUCTION_MEMBERSHIP_DURATION_YEARS,
  demoPaymentsEnabled,
  membershipCapabilities,
}
