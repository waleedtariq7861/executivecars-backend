const Member = require('../models/Member')
const MembershipPayment = require('../models/MembershipPayment')
const { handleControllerError } = require('../utils/http')
const {
  AUCTION_MEMBERSHIP_PRICE,
  AUCTION_MEMBERSHIP_CURRENCY,
  AUCTION_MEMBERSHIP_PLAN,
  AUCTION_MEMBERSHIP_DURATION_YEARS,
  demoPaymentsEnabled,
} = require('../config/auctionMembership')

const requireMemberAccount = (req, res) => {
  if (req.accountModel !== 'member') {
    res.status(403).json({ message: 'A customer account is required for auction membership activation' })
    return false
  }
  return true
}

const membershipPayload = member => ({
  memberId: member._id,
  subscriptionStatus: member.subscriptionStatus,
  subscriptionPlan: member.subscriptionPlan,
  subscriptionStartedAt: member.subscriptionStartedAt,
  subscriptionExpiry: member.subscriptionExpiry,
  paymentMode: member.membershipSource,
  amount: AUCTION_MEMBERSHIP_PRICE,
  currency: AUCTION_MEMBERSHIP_CURRENCY,
})

const completeDemoPayment = async (req, res) => {
  try {
    if (!requireMemberAccount(req, res)) return
    if (!demoPaymentsEnabled()) return res.status(404).json({
      message: 'Membership activation is currently unavailable.', code: 'MEMBERSHIP_UNAVAILABLE',
    })
    const member = req.user
    if (member.hasActiveSubscription()) return res.status(409).json({ message: 'Your auction membership is already active.' })

    // The demo action records a simulation event only. No money, card, provider
    // transaction, receipt, or user-supplied plan/value is involved.
    const startedAt = new Date()
    const expiresAt = new Date(startedAt)
    expiresAt.setFullYear(expiresAt.getFullYear() + AUCTION_MEMBERSHIP_DURATION_YEARS)

    const updated = await Member.db.transaction(async session => {
      const activated = await Member.findOneAndUpdate(
        {
          _id: member._id,
          $or: [
            { subscriptionStatus: { $ne: 'active' } },
            { subscriptionExpiry: { $lte: startedAt } },
            { subscriptionExpiry: null },
          ],
        },
        {
          $set: {
            subscriptionStatus: 'active',
            subscriptionPlan: AUCTION_MEMBERSHIP_PLAN,
            subscriptionStartedAt: startedAt,
            subscriptionExpiry: expiresAt,
            subscriptionUpdatedAt: startedAt,
            membershipSource: 'demo',
          },
        },
        { new: true, runValidators: true, session },
      )
      if (!activated) return null

      await MembershipPayment.create([{
        memberId: activated._id,
        amount: AUCTION_MEMBERSHIP_PRICE,
        currency: AUCTION_MEMBERSHIP_CURRENCY,
        plan: AUCTION_MEMBERSHIP_PLAN,
        paymentMode: 'demo',
        status: 'completed',
      }], { session })
      return activated
    })
    if (!updated) return res.status(409).json({ message: 'Your auction membership is already active.' })
    res.status(201).json({ message: 'Demo activation completed. No payment was processed.', ...membershipPayload(updated) })
  } catch (err) {
    handleControllerError(res, err, 'Could not complete demo membership activation')
  }
}

module.exports = { completeDemoPayment }
