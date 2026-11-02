const { SANDBOX_BANK } = require('../services/sandboxGateway')

const SELLER = Object.freeze({
  name: 'Executive Cars',
  address: 'Stadium Road, Rawalpindi, Pakistan',
  email: 'info@executivecars.pk',
})

const METHOD_LABELS = { card: 'Card', wallet: 'Mobile wallet', bank_transfer: 'Bank transfer' }

const invoiceNumberFor = (year, sequence) => `EC-INV-${year}-${String(sequence).padStart(6, '0')}`

const methodLabel = payment => {
  const details = payment.methodDetails || {}
  if (payment.method === 'card') return `${details.brand || 'Card'} ending ${details.last4}`
  if (payment.method === 'wallet') return `${details.wallet === 'easypaisa' ? 'Easypaisa' : 'JazzCash'} ${details.maskedNumber}`
  if (payment.method === 'bank_transfer') return `Bank transfer, transaction ${details.bankReference}`
  return METHOD_LABELS[payment.method] || 'Payment'
}

// The invoice is built only from what was copied onto the payment, so it is the same every time it is opened.
const buildInvoice = (payment, membership = {}) => ({
  invoiceNumber: payment.invoiceNumber,
  issuedAt: payment.invoiceIssuedAt,
  status: 'PAID',
  sandbox: payment.provider === 'sandbox',
  seller: SELLER,
  buyer: { name: payment.billing?.name, email: payment.billing?.email, phone: payment.billing?.phone },
  lineItems: [{ description: payment.description, quantity: 1, unitPrice: payment.amount, amount: payment.amount }],
  subtotal: payment.amount,
  total: payment.amount,
  amountPaid: payment.amount,
  currency: payment.currency,
  payment: { reference: payment.reference, method: payment.method, methodLabel: methodLabel(payment), paidAt: payment.paidAt },
  coverage: membership.startedAt ? { from: membership.startedAt, to: membership.expiresAt } : undefined,
})

const paymentDto = (payment, { admin = false } = {}) => {
  const details = payment.methodDetails || {}
  return {
    id: payment._id,
    reference: payment.reference,
    plan: payment.plan,
    description: payment.description,
    amount: payment.amount,
    currency: payment.currency,
    provider: payment.provider,
    method: payment.method,
    status: payment.status,
    methodLabel: payment.method ? methodLabel(payment) : undefined,
    bankReference: details.bankReference,
    transferDate: details.transferDate,
    failureCode: payment.failureCode,
    failureMessage: payment.failureMessage,
    invoiceNumber: payment.invoiceNumber,
    expiresAt: payment.expiresAt,
    submittedAt: payment.submittedAt,
    paidAt: payment.paidAt,
    createdAt: payment.createdAt,
    ...(admin ? { member: payment.memberId && payment.memberId.name ? { id: payment.memberId._id, name: payment.memberId.name, email: payment.memberId.email } : undefined } : {}),
  }
}

module.exports = { SELLER, SANDBOX_BANK, invoiceNumberFor, buildInvoice, paymentDto, methodLabel }
