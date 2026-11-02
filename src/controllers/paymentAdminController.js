const mongoose = require('mongoose')
const Payment = require('../models/Payment')
const { handleControllerError } = require('../utils/http')
const { paymentDto } = require('../utils/invoice')
const { settlePayment, failPayment, sendInvoice } = require('./paymentController')

const STATUSES = ['requires_payment', 'processing', 'pending_verification', 'succeeded', 'failed', 'expired']

const listPayments = async (req, res) => {
  try {
    const filter = STATUSES.includes(req.query.status) ? { status: req.query.status } : {}
    const payments = await Payment.find(filter).populate('memberId', 'name email').sort({ createdAt: -1 }).limit(200)
    const [succeeded, pending] = await Promise.all([
      Payment.aggregate([{ $match: { status: 'succeeded' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Payment.countDocuments({ status: 'pending_verification' }),
    ])
    res.json({
      payments: payments.map(item => paymentDto(item, { admin: true })),
      summary: { succeededCount: succeeded[0]?.count || 0, succeededTotal: succeeded[0]?.total || 0, pendingVerification: pending, currency: 'PKR' },
    })
  } catch (error) {
    handleControllerError(res, error, 'Could not load payments')
  }
}

const loadPending = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ message: 'Payment not found' }); return null }
  const payment = await Payment.findById(req.params.id)
  if (!payment) { res.status(404).json({ message: 'Payment not found' }); return null }
  if (payment.status !== 'pending_verification') {
    res.status(409).json({ message: 'Only a bank transfer that is waiting for confirmation can be confirmed or rejected.', code: 'NOT_PENDING' })
    return null
  }
  return payment
}

const confirmPayment = async (req, res) => {
  try {
    const payment = await loadPending(req, res)
    if (!payment) return
    const settled = await settlePayment(payment, { confirmedBy: req.user._id })
    if (!settled) {
      const failed = await failPayment(payment._id, { code: 'ALREADY_MEMBER', message: 'The customer already has an active membership.' })
      return res.status(409).json({ message: 'The customer already has an active membership.', code: 'ALREADY_MEMBER', payment: paymentDto(failed, { admin: true }) })
    }
    sendInvoice(settled.payment, settled.coverage)
    res.json({ payment: paymentDto(settled.payment, { admin: true }) })
  } catch (error) {
    handleControllerError(res, error, 'Could not confirm the payment')
  }
}

const rejectPayment = async (req, res) => {
  try {
    const payment = await loadPending(req, res)
    if (!payment) return
    const reason = String(req.body.reason || '').trim().slice(0, 200) || 'The transfer could not be matched to a deposit.'
    const failed = await failPayment(payment._id, { code: 'TRANSFER_REJECTED', message: reason })
    res.json({ payment: paymentDto(failed, { admin: true }) })
  } catch (error) {
    handleControllerError(res, error, 'Could not reject the payment')
  }
}

module.exports = { listPayments, confirmPayment, rejectPayment }
