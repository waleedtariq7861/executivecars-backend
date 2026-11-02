const crypto = require('crypto')
const mongoose = require('mongoose')
const Member = require('../models/Member')
const Payment = require('../models/Payment')
const { nextSequence } = require('../models/Counter')
const { handleControllerError } = require('../utils/http')
const { sendInBackground } = require('../utils/background')
const email = require('../utils/email')
const gateway = require('../services/sandboxGateway')
const { buildInvoice, paymentDto, invoiceNumberFor } = require('../utils/invoice')
const { membershipPlan, AUCTION_MEMBERSHIP_DURATION_YEARS } = require('../config/auctionMembership')

const PAYMENT_LIFETIME_MS = 60 * 60 * 1000
const METHOD_IDS = gateway.METHODS.map(method => method.id)

const newReference = () => `EC-PAY-${crypto.randomBytes(5).toString('hex').toUpperCase()}`

// The payment is settled, the membership activated and the invoice numbered in one transaction: either the
// customer has all three or none of them.
class AlreadyMember extends Error {}

const settlePayment = async (payment, { confirmedBy } = {}) => {
  try {
    return await Member.db.transaction(async session => {
      const startedAt = new Date()
      const endsAt = new Date(startedAt)
      endsAt.setFullYear(endsAt.getFullYear() + AUCTION_MEMBERSHIP_DURATION_YEARS)

      const member = await Member.findOneAndUpdate(
        {
          _id: payment.memberId,
          $or: [{ subscriptionStatus: { $ne: 'active' } }, { subscriptionExpiry: { $lte: startedAt } }, { subscriptionExpiry: null }],
        },
        {
          $set: {
            subscriptionStatus: 'active', subscriptionPlan: payment.plan, subscriptionStartedAt: startedAt,
            subscriptionExpiry: endsAt, subscriptionUpdatedAt: startedAt, membershipSource: 'payment', membershipPaymentId: payment._id,
          },
        },
        { new: true, runValidators: true, session },
      )
      if (!member) throw new AlreadyMember()

      const number = invoiceNumberFor(startedAt.getFullYear(), await nextSequence(`invoice:${startedAt.getFullYear()}`, session))
      const settled = await Payment.findOneAndUpdate(
        { _id: payment._id, status: { $in: ['processing', 'pending_verification'] } },
        {
          $set: { status: 'succeeded', paidAt: startedAt, invoiceNumber: number, invoiceIssuedAt: startedAt, ...(confirmedBy ? { confirmedBy } : {}) },
          $unset: { failureCode: 1, failureMessage: 1 },
        },
        { new: true, session },
      )
      if (!settled) throw new Error('Payment is no longer open')
      return { payment: settled, member, coverage: { startedAt, expiresAt: endsAt } }
    })
  } catch (error) {
    if (error instanceof AlreadyMember) return null
    throw error
  }
}

const failPayment = (paymentId, { code, message, details }) => Payment.findByIdAndUpdate(
  paymentId,
  { $set: { status: 'failed', failureCode: code, failureMessage: message, ...(details ? { methodDetails: details } : {}) } },
  { new: true },
)

const sendInvoice = (settled, coverage) => sendInBackground('Invoice', () => email.sendInvoiceEmail(settled.billing.email, buildInvoice(settled, coverage)))

const plan = (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ...membershipPlan(), provider: 'sandbox' })
}

const methods = (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    provider: 'sandbox',
    methods: gateway.METHODS,
    wallets: Object.entries(gateway.WALLETS).map(([id, label]) => ({ id, label })),
    bank: gateway.SANDBOX_BANK,
  })
}

const createPayment = async (req, res) => {
  try {
    const member = req.user
    if (member.hasActiveSubscription()) return res.status(409).json({ message: 'Your auction membership is already active.', code: 'ALREADY_MEMBER' })

    const open = await Payment.findOne({ memberId: member._id, status: { $in: ['requires_payment', 'processing', 'pending_verification'] }, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 })
    if (open?.status === 'pending_verification') {
      return res.status(409).json({ message: 'Your bank transfer is waiting to be confirmed.', code: 'PAYMENT_PENDING_VERIFICATION', payment: paymentDto(open) })
    }
    if (open) return res.json({ payment: paymentDto(open) })

    const current = membershipPlan()
    const payment = await Payment.create({
      memberId: member._id,
      reference: newReference(),
      plan: current.id,
      description: `${current.name} (${current.durationYears} year)`,
      amount: current.amount,
      currency: current.currency,
      billing: { name: member.name, email: member.email, phone: member.phone },
      expiresAt: new Date(Date.now() + PAYMENT_LIFETIME_MS),
    })
    res.status(201).json({ payment: paymentDto(payment) })
  } catch (error) {
    handleControllerError(res, error, 'Could not start the payment')
  }
}

const loadOwn = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ message: 'Payment not found' }); return null }
  const payment = await Payment.findOne({ _id: req.params.id, memberId: req.user._id })
  if (!payment) { res.status(404).json({ message: 'Payment not found' }); return null }
  return payment
}

const payPayment = async (req, res) => {
  try {
    const payment = await loadOwn(req, res)
    if (!payment) return

    const method = String(req.body.method || '')
    if (!METHOD_IDS.includes(method)) {
      return res.status(400).json({ message: 'Choose a payment method.', code: 'INVALID_METHOD', errors: { method: 'Choose a payment method.' } })
    }

    // Paying twice with the same payment never charges twice: the earlier outcome is returned.
    if (payment.status === 'succeeded') return res.json({ payment: paymentDto(payment), invoiceNumber: payment.invoiceNumber })
    if (payment.status === 'processing' || payment.status === 'pending_verification') {
      return res.status(409).json({ message: 'This payment is already being processed.', code: 'PAYMENT_IN_PROGRESS', payment: paymentDto(payment) })
    }
    if (payment.status !== 'requires_payment') {
      return res.status(409).json({ message: 'This payment can no longer be used. Start a new one.', code: 'PAYMENT_CLOSED', payment: paymentDto(payment) })
    }
    if (payment.expiresAt <= new Date()) {
      await Payment.updateOne({ _id: payment._id, status: 'requires_payment' }, { $set: { status: 'expired' } })
      return res.status(409).json({ message: 'This payment expired. Start a new one.', code: 'PAYMENT_EXPIRED' })
    }
    if (req.user.hasActiveSubscription()) return res.status(409).json({ message: 'Your auction membership is already active.', code: 'ALREADY_MEMBER' })

    // Only one request can take the payment from "requires_payment" to "processing".
    const claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: 'requires_payment', expiresAt: { $gt: new Date() } },
      { $set: { status: 'processing', method, submittedAt: new Date() } },
      { new: true },
    )
    if (!claimed) return res.status(409).json({ message: 'This payment is already being processed.', code: 'PAYMENT_IN_PROGRESS' })

    const result = method === 'card' ? gateway.chargeCard(req.body.card)
      : method === 'wallet' ? gateway.chargeWallet(req.body.wallet)
        : gateway.bankTransfer(req.body.bankTransfer)

    if (result.validation) {
      // Nothing was attempted, so the payment goes back to waiting and can be submitted again.
      await Payment.updateOne({ _id: payment._id }, { $set: { status: 'requires_payment' }, $unset: { method: 1, submittedAt: 1 } })
      return res.status(400).json({ message: result.message, code: result.code, errors: result.field ? { [result.field]: result.message } : {} })
    }
    if (!result.ok) {
      const failed = await failPayment(payment._id, result)
      return res.status(402).json({ message: result.message, code: result.code, payment: paymentDto(failed) })
    }

    if (method === 'bank_transfer') {
      const pending = await Payment.findByIdAndUpdate(payment._id, { $set: { status: 'pending_verification', methodDetails: result.details } }, { new: true })
      return res.status(202).json({ payment: paymentDto(pending), message: 'Transfer details received. An administrator will confirm your payment.' })
    }

    await Payment.updateOne({ _id: payment._id }, { $set: { methodDetails: result.details } })
    let settled
    try {
      settled = await settlePayment(await Payment.findById(payment._id))
    } catch (error) {
      // The transaction left nothing half-done; put the payment back so the customer can simply try again.
      await Payment.updateOne({ _id: payment._id, status: 'processing' }, { $set: { status: 'requires_payment' }, $unset: { method: 1, submittedAt: 1, methodDetails: 1 } })
      throw error
    }
    if (!settled) {
      const failed = await failPayment(payment._id, { code: 'ALREADY_MEMBER', message: 'Your auction membership is already active.' })
      return res.status(409).json({ message: 'Your auction membership is already active.', code: 'ALREADY_MEMBER', payment: paymentDto(failed) })
    }
    sendInvoice(settled.payment, settled.coverage)
    res.status(201).json({ payment: paymentDto(settled.payment), invoiceNumber: settled.payment.invoiceNumber })
  } catch (error) {
    handleControllerError(res, error, 'Could not complete the payment')
  }
}

const listMyPayments = async (req, res) => {
  try {
    const payments = await Payment.find({ memberId: req.user._id }).sort({ createdAt: -1 }).limit(50)
    res.set('Cache-Control', 'no-store').json({ payments: payments.map(item => paymentDto(item)) })
  } catch (error) {
    handleControllerError(res, error, 'Could not load your payments')
  }
}

const getPayment = async (req, res) => {
  try {
    const payment = await loadOwn(req, res)
    if (!payment) return
    res.set('Cache-Control', 'no-store').json({ payment: paymentDto(payment) })
  } catch (error) {
    handleControllerError(res, error, 'Could not load the payment')
  }
}

const getInvoice = async (req, res) => {
  try {
    const payment = await loadOwn(req, res)
    if (!payment) return
    if (payment.status !== 'succeeded' || !payment.invoiceNumber) {
      return res.status(409).json({ message: 'An invoice is issued once the payment has succeeded.', code: 'NO_INVOICE' })
    }
    const member = await Member.findById(payment.memberId).select('subscriptionStartedAt subscriptionExpiry membershipPaymentId')
    const covers = member && String(member.membershipPaymentId) === String(payment._id)
    res.set('Cache-Control', 'no-store').json({
      invoice: buildInvoice(payment, covers ? { startedAt: member.subscriptionStartedAt, expiresAt: member.subscriptionExpiry } : {}),
    })
  } catch (error) {
    handleControllerError(res, error, 'Could not load the invoice')
  }
}

module.exports = { plan, methods, createPayment, payPayment, listMyPayments, getPayment, getInvoice, settlePayment, failPayment, sendInvoice }
