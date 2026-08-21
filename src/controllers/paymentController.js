const Stripe = require('stripe')
const Member = require('../models/Member')
const MembershipPayment = require('../models/MembershipPayment')
const { handleControllerError } = require('../utils/http')
const {
  AUCTION_MEMBERSHIP_PRICE, AUCTION_MEMBERSHIP_CURRENCY, AUCTION_MEMBERSHIP_PLAN,
  AUCTION_MEMBERSHIP_DURATION_YEARS, demoPaymentsEnabled,
} = require('../config/auctionMembership')

let stripeClient
const getStripe = () => {
  const key = process.env.STRIPE_SECRET_KEY || ''
  if (!key.startsWith('sk_') || /local|your_/i.test(key)) {
    const error = new Error('Stripe is not configured. Add a valid STRIPE_SECRET_KEY.')
    error.status = 503
    throw error
  }
  if (!stripeClient) stripeClient = new Stripe(key)
  return stripeClient
}

const requireMemberAccount = (req, res) => {
  if (req.accountModel !== 'member') {
    res.status(403).json({ message: 'A customer account is required for membership payments' })
    return false
  }
  return true
}

const membershipPayload = member => ({
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
    if (!demoPaymentsEnabled()) return res.status(503).json({ message: 'Demo checkout is not available in this environment.' })
    const member = req.user
    if (member.hasActiveSubscription()) return res.status(409).json({ message: 'Your auction membership is already active.' })
    const startedAt = new Date()
    const expiresAt = new Date(startedAt)
    expiresAt.setFullYear(expiresAt.getFullYear() + AUCTION_MEMBERSHIP_DURATION_YEARS)
    member.subscriptionStatus = 'active'
    member.subscriptionPlan = AUCTION_MEMBERSHIP_PLAN
    member.subscriptionStartedAt = startedAt
    member.subscriptionExpiry = expiresAt
    member.subscriptionUpdatedAt = startedAt
    member.membershipSource = 'demo'
    await member.save()
    await MembershipPayment.create({
      memberId: member._id,
      amount: AUCTION_MEMBERSHIP_PRICE,
      currency: AUCTION_MEMBERSHIP_CURRENCY,
      plan: AUCTION_MEMBERSHIP_PLAN,
      paymentMode: 'demo',
      status: 'completed',
    })
    res.status(201).json({ message: 'Test payment completed successfully.', ...membershipPayload(member) })
  } catch (err) {
    handleControllerError(res, err, 'Could not complete test payment')
  }
}

// Create Stripe checkout session for annual membership (PKR 4,999)
const createCheckoutSession = async (req, res) => {
  try {
    if (!requireMemberAccount(req, res)) return
    const member = req.user
    if (member.hasActiveSubscription()) {
      return res.status(409).json({ message: 'Your auction membership is already active' })
    }
    const stripe = getStripe()

    // Convert PKR 4999 to paisa (Stripe uses smallest currency unit)
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: member.email,
      metadata: { memberId: member._id.toString() },
      line_items: [{
        price_data: {
          currency: 'pkr',
          product_data: {
            name: 'Annual Auction Membership',
            description: 'Annual membership — full platform access',
          },
        unit_amount: AUCTION_MEMBERSHIP_PRICE * 100,
        },
        quantity: 1,
      }],
      success_url: `${process.env.CLIENT_URL}/auction/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.CLIENT_URL}/auction/payment`,
    })

    // Store checkout session id on member for webhook lookup
    await Member.findByIdAndUpdate(member._id, { checkoutSessionId: session.id })

    res.json({ url: session.url, sessionId: session.id })
  } catch (err) {
    handleControllerError(res, err, 'Unable to start secure checkout')
  }
}

// Stripe webhook — activates membership after successful payment
const handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    if (!sig) return res.status(400).json({ message: 'Stripe signature is required' })
    const stripe = getStripe()
    if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ message: 'Stripe webhook is not configured' })
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.status ? err.message : `Webhook error: ${err.message}` })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const memberId = session.metadata?.memberId

    if (memberId) {
      const expiry = new Date()
      expiry.setFullYear(expiry.getFullYear() + 1)

      await Member.findByIdAndUpdate(memberId, {
      subscriptionStatus: 'active', subscriptionPlan: AUCTION_MEMBERSHIP_PLAN,
      subscriptionStartedAt: new Date(), subscriptionExpiry: expiry, subscriptionUpdatedAt: new Date(),
        stripeCustomerId:   session.customer || '',
        checkoutSessionId:  session.id,
      })
    }
  }

  res.json({ received: true })
}

// Verify a completed Stripe session and return fresh member subscription data
const verifySession = async (req, res) => {
  try {
    if (!requireMemberAccount(req, res)) return
    const { session_id } = req.query
    if (!session_id) return res.status(400).json({ message: 'session_id required' })

    const stripe = getStripe()
    const session = await stripe.checkout.sessions.retrieve(session_id)
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ message: 'Payment not completed' })
    }

    const memberId = session.metadata?.memberId
    if (!memberId) return res.status(400).json({ message: 'No member linked to this session' })
    if (memberId !== req.user._id.toString()) {
      return res.status(403).json({ message: 'This payment session belongs to another account' })
    }

    const expiry = new Date()
    expiry.setFullYear(expiry.getFullYear() + 1)
    const member = await Member.findByIdAndUpdate(
      memberId,
      {
        subscriptionStatus: 'active', subscriptionPlan: AUCTION_MEMBERSHIP_PLAN,
        subscriptionStartedAt: new Date(), subscriptionExpiry: expiry, subscriptionUpdatedAt: new Date(),
        stripeCustomerId: session.customer || req.user.stripeCustomerId || '',
        checkoutSessionId: session.id,
      },
      { new: true, runValidators: true }
    ).select('_id subscriptionStatus subscriptionExpiry email name')
    if (!member) return res.status(404).json({ message: 'Member not found' })

    res.json({
      memberId: member._id,
      subscriptionStatus: member.subscriptionStatus,
      subscriptionExpiry: member.subscriptionExpiry,
    })
  } catch (err) {
    handleControllerError(res, err, 'Could not verify payment')
  }
}

module.exports = { createCheckoutSession, handleWebhook, verifySession, completeDemoPayment }
