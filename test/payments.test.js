process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'smtp'
process.env.ENABLE_DEMO_SEED = 'true'
const { DEFAULT_TEST_URI, validateTestUri, connectTestDatabase, dropTestDatabase, resetTestDatabase } = require('./helpers/localDatabase')
process.env.MONGO_URI = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GROQ_API_KEY', 'ML_SERVICE_KEY', 'RESEND_API_KEY']) process.env[key] = ''

const { before, after, beforeEach, afterEach, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const mongoose = require('mongoose')
require('./helpers/noRateLimits')
const request = require('supertest')
require('./helpers/cookieAuth')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const Member = require('../src/models/Member')
const Payment = require('../src/models/Payment')
const Counter = require('../src/models/Counter')
const email = require('../src/utils/email')
const gateway = require('../src/services/sandboxGateway')
const { AUCTION_MEMBERSHIP_PRICE } = require('../src/config/auctionMembership')

let app

before(async () => {
  await connectTestDatabase()
  app = createApp()
})

after(async () => {
  if (mongoose.connection.readyState === 1) {
    try { await dropTestDatabase() } finally { await mongoose.disconnect() }
  }
})

const original = { invoice: email.sendInvoiceEmail }
let invoiceMails
beforeEach(async () => {
  await resetTestDatabase()
  invoiceMails = []
  email.sendInvoiceEmail = async (to, invoice) => { invoiceMails.push({ to, invoice }) }
})
afterEach(() => { email.sendInvoiceEmail = original.invoice })

const TEST_CARD = { number: '4242 4242 4242 4242', expMonth: 12, expYear: new Date().getFullYear() + 2, cvc: '123', name: 'Test Customer' }
const person = (n = 1) => ({ name: `Payment Customer${'x'.repeat(0)}`, email: `payer${n}@example.com`, phone: `+92 300 55503${String(n).padStart(2, '0')}`, password: 'orchid-lantern-42' })

// A signed-in customer whose email is already verified (verification itself is tested elsewhere).
const customer = async (n = 1) => {
  const response = await request(app).post('/api/auth/register').send(person(n))
  assert.equal(response.status, 201)
  await Member.updateOne({ email: person(n).email }, { $set: { emailVerifiedAt: new Date() } })
  return { auth: { Authorization: `Bearer ${response.body.token}` }, member: await Member.findOne({ email: person(n).email }) }
}
const adminAuth = async () => {
  const admin = await Admin.create({ name: 'Payment Admin', email: 'payment-admin@example.com', password: 'admin-pass-123', role: 'admin' })
  const login = await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })
  return { auth: { Authorization: `Bearer ${login.body.token}` }, admin }
}
const start = auth => request(app).post('/api/payments').set(auth)
const pay = (auth, id, body) => request(app).post(`/api/payments/${id}/pay`).set(auth).send(body)
const startAndPay = async (auth, body) => {
  const created = await start(auth)
  return { created, paid: await pay(auth, created.body.payment.id, body) }
}
const payByCard = (auth, card = {}) => startAndPay(auth, { method: 'card', card: { ...TEST_CARD, ...card } })

describe('the sandbox gateway', () => {
  test('accepts only published test cards and says so for any other number', () => {
    for (const number of ['4111 1111 1111 1111', '5105 1051 0510 5100', '378282246310005']) {
      const result = gateway.chargeCard({ ...TEST_CARD, number, cvc: number.startsWith('378') ? '1234' : '123' })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'NOT_A_TEST_CARD', number)
      assert.equal(result.validation, true)
      assert.equal(result.field, 'cardNumber')
      assert.ok(!JSON.stringify(result).includes(number.replace(/\s/g, '')), 'a refused card number is never echoed back')
    }
  })

  test('approves the test cards and reports declines with their own reasons', () => {
    const approved = gateway.chargeCard(TEST_CARD)
    assert.deepEqual(approved, { ok: true, details: { brand: 'Visa', last4: '4242' } })
    assert.equal(gateway.chargeCard({ ...TEST_CARD, number: '5555555555554444' }).details.brand, 'Mastercard')
    const declined = gateway.chargeCard({ ...TEST_CARD, number: '4000000000000002' })
    assert.deepEqual([declined.ok, declined.validation, declined.code], [false, false, 'CARD_DECLINED'])
    assert.equal(gateway.chargeCard({ ...TEST_CARD, number: '4000000000009995' }).code, 'INSUFFICIENT_FUNDS')
  })

  test('checks the number, expiry, security code and name before anything else', () => {
    const code = card => gateway.chargeCard({ ...TEST_CARD, ...card }).code
    assert.equal(code({ number: '4242 4242 4242 4241' }), 'INVALID_CARD_NUMBER')
    assert.equal(code({ number: '1234' }), 'INVALID_CARD_NUMBER')
    assert.equal(code({ number: 'abcd efgh ijkl mnop' }), 'INVALID_CARD_NUMBER')
    assert.equal(code({ expMonth: 13 }), 'INVALID_EXPIRY')
    assert.equal(code({ expMonth: 1, expYear: new Date().getFullYear() - 1 }), 'CARD_EXPIRED')
    // Earlier this year is expired too (not possible in January, when no earlier month exists).
    if (new Date().getMonth() > 0) assert.equal(code({ expMonth: 1, expYear: new Date().getFullYear() }), 'CARD_EXPIRED')
    assert.equal(code({ expMonth: new Date().getMonth() + 1, expYear: new Date().getFullYear() }), undefined, 'the current month is still valid')
    assert.equal(code({ cvc: '12' }), 'INVALID_CVC')
    assert.equal(code({ cvc: 'abc' }), 'INVALID_CVC')
    assert.equal(code({ name: ' ' }), 'INVALID_NAME')
    assert.equal(gateway.chargeCard({ ...TEST_CARD, expYear: '30' }).ok, true, 'two-digit years are accepted')
  })

  test('wallets: only test numbers, with approved, declined and insufficient-balance outcomes', () => {
    assert.equal(gateway.chargeWallet({ provider: 'jazzcash', number: '0300 0000001' }).ok, true)
    assert.equal(gateway.chargeWallet({ provider: 'easypaisa', number: '03000000001' }).details.maskedNumber, '0300•••••01')
    assert.equal(gateway.chargeWallet({ provider: 'jazzcash', number: '03000000002' }).code, 'WALLET_DECLINED')
    assert.equal(gateway.chargeWallet({ provider: 'jazzcash', number: '03000000003' }).code, 'INSUFFICIENT_FUNDS')
    assert.equal(gateway.chargeWallet({ provider: 'jazzcash', number: '03211234567' }).code, 'NOT_A_TEST_ACCOUNT')
    assert.equal(gateway.chargeWallet({ provider: 'jazzcash', number: '12345' }).code, 'INVALID_WALLET_NUMBER')
    assert.equal(gateway.chargeWallet({ provider: 'nayapay', number: '03000000001' }).code, 'INVALID_WALLET')
  })

  test('bank transfer details need a reference and a recent, real date', () => {
    const now = new Date('2026-11-10T10:00:00Z')
    assert.equal(gateway.bankTransfer({ reference: 'TXN-123456', date: '2026-11-09' }, now).ok, true)
    assert.equal(gateway.bankTransfer({ reference: '12', date: '2026-11-09' }, now).code, 'INVALID_TRANSFER_REFERENCE')
    assert.equal(gateway.bankTransfer({ reference: 'TXN-123456', date: 'someday' }, now).code, 'INVALID_TRANSFER_DATE')
    assert.equal(gateway.bankTransfer({ reference: 'TXN-123456', date: '2026-12-25' }, now).code, 'INVALID_TRANSFER_DATE')
    assert.equal(gateway.bankTransfer({ reference: 'TXN-123456', date: '2026-09-01' }, now).code, 'INVALID_TRANSFER_DATE')
  })
})

describe('starting a payment', () => {
  test('the plan and methods are public; the price comes from the server', async () => {
    const plan = await request(app).get('/api/payments/plan')
    assert.equal(plan.status, 200)
    assert.deepEqual([plan.body.amount, plan.body.currency, plan.body.provider], [AUCTION_MEMBERSHIP_PRICE, 'PKR', 'sandbox'])
    const methods = await request(app).get('/api/payments/methods')
    assert.deepEqual(methods.body.methods.map(method => method.id), ['card', 'wallet', 'bank_transfer'])
    assert.equal(methods.body.bank.accountTitle, 'Executive Cars (Sandbox)')
  })

  test('needs a signed-in, email-verified customer', async () => {
    assert.equal((await request(app).post('/api/payments')).status, 401)
    const { admin } = await adminAuth()
    const login = await request(app).post('/api/auth/admin/login').send({ email: admin.email, password: 'admin-pass-123' })
    assert.equal((await start({ Authorization: `Bearer ${login.body.token}` })).status, 403)
    const unverified = await request(app).post('/api/auth/register').send(person(9))
    const blocked = await start({ Authorization: `Bearer ${unverified.body.token}` })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.code, 'EMAIL_NOT_VERIFIED')
  })

  test('creates a payment priced by the server, ignoring any amount the browser sends', async () => {
    const { auth, member } = await customer()
    const response = await request(app).post('/api/payments').set(auth).send({ amount: 1, currency: 'USD', plan: 'free' })
    assert.equal(response.status, 201)
    const { payment } = response.body
    assert.match(payment.reference, /^EC-PAY-[0-9A-F]{10}$/)
    assert.deepEqual([payment.status, payment.amount, payment.currency], ['requires_payment', AUCTION_MEMBERSHIP_PRICE, 'PKR'])
    const stored = await Payment.findById(payment.id)
    assert.equal(String(stored.memberId), String(member._id))
    assert.equal(stored.billing.email, member.email)
    assert.ok(stored.expiresAt.getTime() > Date.now() + 50 * 60 * 1000)
  })

  test('asking again while one is open returns the same payment', async () => {
    const { auth } = await customer()
    const first = await start(auth)
    const second = await start(auth)
    assert.equal(second.status, 200)
    assert.equal(second.body.payment.id, first.body.payment.id)
    assert.equal(await Payment.countDocuments(), 1)
  })

  test('a customer who already has an active membership cannot start another payment', async () => {
    const { auth, member } = await customer()
    await Member.updateOne({ _id: member._id }, { $set: { subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 86_400_000) } })
    const response = await start(auth)
    assert.equal(response.status, 409)
    assert.equal(response.body.code, 'ALREADY_MEMBER')
  })
})

describe('paying by card', () => {
  test('a test card activates the membership, issues invoice 000001 and records only the brand and last four digits', async () => {
    const { auth, member } = await customer()
    const { paid } = await payByCard(auth)
    assert.equal(paid.status, 201)
    assert.equal(paid.body.payment.status, 'succeeded')
    assert.match(paid.body.invoiceNumber, new RegExp(`^EC-INV-${new Date().getFullYear()}-000001$`))
    assert.equal(paid.body.payment.methodLabel, 'Visa ending 4242')

    const updated = await Member.findById(member._id)
    assert.equal(updated.subscriptionStatus, 'active')
    assert.equal(updated.membershipSource, 'payment')
    assert.equal(String(updated.membershipPaymentId), paid.body.payment.id)
    assert.ok(updated.subscriptionExpiry.getTime() > Date.now() + 360 * 86_400_000)

    const raw = JSON.stringify(await Payment.collection.find().toArray())
    for (const secret of ['4242424242424242', '4242 4242 4242 4242', '"cvc"', '"number"']) assert.ok(!raw.includes(secret), `${secret} must not be stored`)
    const session = await request(app).get('/api/auth/session').set(auth)
    assert.equal(session.body.user.capabilities.auction, true)
    assert.equal(session.body.user.membershipSource, 'payment')
  })

  test('the invoice is emailed once, to the billing address', async () => {
    const { auth, member } = await customer()
    await payByCard(auth)
    assert.equal(invoiceMails.length, 1)
    assert.equal(invoiceMails[0].to, member.email)
    assert.match(invoiceMails[0].invoice.invoiceNumber, /^EC-INV-/)
  })

  test('paying again with the same payment returns the earlier result and charges nothing twice', async () => {
    const { auth } = await customer()
    const { created, paid } = await payByCard(auth)
    const again = await pay(auth, created.body.payment.id, { method: 'card', card: TEST_CARD })
    assert.equal(again.status, 200)
    assert.equal(again.body.invoiceNumber, paid.body.invoiceNumber)
    assert.equal(await Payment.countDocuments({ status: 'succeeded' }), 1)
    assert.equal(invoiceMails.length, 1)
  })

  test('invoice numbers run in order across customers', async () => {
    const one = await customer(1)
    const two = await customer(2)
    const first = (await payByCard(one.auth)).paid.body.invoiceNumber
    const second = (await payByCard(two.auth)).paid.body.invoiceNumber
    assert.deepEqual([first.slice(-6), second.slice(-6)], ['000001', '000002'])
  })

  test('parallel attempts produce one payment, one membership and one invoice', async () => {
    const { auth, member } = await customer()
    const created = await start(auth)
    const id = created.body.payment.id
    const results = await Promise.all(Array.from({ length: 4 }, () => pay(auth, id, { method: 'card', card: TEST_CARD })))
    assert.equal(results.filter(result => result.status === 201).length, 1)
    assert.ok(results.every(result => [200, 201, 409].includes(result.status)), results.map(result => result.status).join(','))
    assert.equal(await Payment.countDocuments({ status: 'succeeded' }), 1)
    assert.equal(await Counter.findById(`invoice:${new Date().getFullYear()}`).then(counter => counter.seq), 1)
    assert.equal(invoiceMails.length, 1)
    assert.equal((await Member.findById(member._id)).subscriptionStatus, 'active')
  })

  test('a declined card is recorded as failed, leaves the customer without membership and can be retried with a new payment', async () => {
    const { auth, member } = await customer()
    const { created, paid } = await payByCard(auth, { number: '4000 0000 0000 0002' })
    assert.equal(paid.status, 402)
    assert.equal(paid.body.code, 'CARD_DECLINED')
    assert.equal(paid.body.payment.status, 'failed')
    assert.equal((await Member.findById(member._id)).subscriptionStatus, 'inactive')
    assert.equal(invoiceMails.length, 0)
    const stale = await pay(auth, created.body.payment.id, { method: 'card', card: TEST_CARD })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'PAYMENT_CLOSED')

    const retry = await payByCard(auth)
    assert.notEqual(retry.created.body.payment.id, created.body.payment.id)
    assert.equal(retry.paid.status, 201)
    const history = await request(app).get('/api/payments').set(auth)
    assert.deepEqual(history.body.payments.map(item => item.status).sort(), ['failed', 'succeeded'])
  })

  test('insufficient funds is reported as its own reason', async () => {
    const { auth } = await customer()
    const { paid } = await payByCard(auth, { number: '4000 0000 0000 9995' })
    assert.equal(paid.status, 402)
    assert.equal(paid.body.code, 'INSUFFICIENT_FUNDS')
  })

  test('invalid details are a field error, nothing is attempted and the same payment can be submitted again', async () => {
    const { auth } = await customer()
    const { created, paid } = await payByCard(auth, { cvc: '1' })
    assert.equal(paid.status, 400)
    assert.equal(paid.body.code, 'INVALID_CVC')
    assert.ok(paid.body.errors.cvc)
    const stored = await Payment.findById(created.body.payment.id)
    assert.equal(stored.status, 'requires_payment')
    assert.equal(stored.method, undefined)
    assert.equal((await pay(auth, created.body.payment.id, { method: 'card', card: TEST_CARD })).status, 201)
  })

  test('a real card number is refused, is not charged, and is not stored anywhere', async () => {
    const { auth, member } = await customer()
    const { paid } = await payByCard(auth, { number: '4111 1111 1111 1111' })
    assert.equal(paid.status, 400)
    assert.equal(paid.body.code, 'NOT_A_TEST_CARD')
    assert.ok(!JSON.stringify(paid.body).includes('4111'))
    assert.equal((await Member.findById(member._id)).subscriptionStatus, 'inactive')
    assert.ok(!JSON.stringify(await Payment.collection.find().toArray()).includes('4111'))
  })

  test('an unknown method is refused', async () => {
    const { auth } = await customer()
    const created = await start(auth)
    const response = await pay(auth, created.body.payment.id, { method: 'cash' })
    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'INVALID_METHOD')
  })

  test('an expired payment cannot be paid', async () => {
    const { auth } = await customer()
    const created = await start(auth)
    await Payment.updateOne({ _id: created.body.payment.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    const response = await pay(auth, created.body.payment.id, { method: 'card', card: TEST_CARD })
    assert.equal(response.status, 409)
    assert.equal(response.body.code, 'PAYMENT_EXPIRED')
    assert.equal((await Payment.findById(created.body.payment.id)).status, 'expired')
  })

  test('if the membership cannot be recorded, nothing is half-done and the payment can be tried again', async () => {
    const { auth, member } = await customer()
    const created = await start(auth)
    const real = Counter.findOneAndUpdate
    Counter.findOneAndUpdate = () => { throw new Error('Injected invoice-number failure') }
    let failed
    try { failed = await pay(auth, created.body.payment.id, { method: 'card', card: TEST_CARD }) } finally { Counter.findOneAndUpdate = real }
    assert.equal(failed.status, 500)
    assert.equal((await Member.findById(member._id)).subscriptionStatus, 'inactive', 'the membership rolled back with the invoice')
    const stored = await Payment.findById(created.body.payment.id)
    assert.equal(stored.status, 'requires_payment')
    assert.equal(stored.invoiceNumber, undefined)
    const retry = await pay(auth, created.body.payment.id, { method: 'card', card: TEST_CARD })
    assert.equal(retry.status, 201)
  })
})

describe('paying with a mobile wallet', () => {
  test('a test wallet number is approved and shown masked on the invoice', async () => {
    const { auth } = await customer()
    const { paid } = await startAndPay(auth, { method: 'wallet', wallet: { provider: 'easypaisa', number: '03000000001' } })
    assert.equal(paid.status, 201)
    assert.equal(paid.body.payment.methodLabel, 'Easypaisa 0300•••••01')
    assert.ok(!JSON.stringify(await Payment.collection.find().toArray()).includes('03000000001'))
  })

  test('declined and insufficient-balance wallets fail with their own reasons; real numbers are refused', async () => {
    const { auth } = await customer()
    const declined = await startAndPay(auth, { method: 'wallet', wallet: { provider: 'jazzcash', number: '03000000002' } })
    assert.equal(declined.paid.status, 402)
    assert.equal(declined.paid.body.code, 'WALLET_DECLINED')
    const poor = await startAndPay(auth, { method: 'wallet', wallet: { provider: 'jazzcash', number: '03000000003' } })
    assert.equal(poor.paid.body.code, 'INSUFFICIENT_FUNDS')
    const real = await startAndPay(auth, { method: 'wallet', wallet: { provider: 'jazzcash', number: '03211234567' } })
    assert.equal(real.paid.status, 400)
    assert.equal(real.paid.body.code, 'NOT_A_TEST_ACCOUNT')
  })
})

describe('paying by bank transfer', () => {
  const transfer = { method: 'bank_transfer', bankTransfer: { reference: 'TXN-784512', date: new Date().toISOString().slice(0, 10) } }

  test('waits for an administrator: no membership and no invoice until confirmed', async () => {
    const { auth, member } = await customer()
    const { created, paid } = await startAndPay(auth, transfer)
    assert.equal(paid.status, 202)
    assert.equal(paid.body.payment.status, 'pending_verification')
    assert.equal(paid.body.payment.bankReference, 'TXN-784512')
    assert.equal((await Member.findById(member._id)).subscriptionStatus, 'inactive')
    assert.equal((await request(app).get(`/api/payments/${created.body.payment.id}/invoice`).set(auth)).status, 409)
    const again = await start(auth)
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'PAYMENT_PENDING_VERIFICATION')
  })

  test('an administrator confirms it: membership, invoice and email follow, and the confirmer is recorded', async () => {
    const { auth, member } = await customer()
    const { created } = await startAndPay(auth, transfer)
    const { auth: admin, admin: adminDoc } = await adminAuth()
    const listed = await request(app).get('/api/admin/payments?status=pending_verification').set(admin)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.payments[0].member.email, member.email)
    assert.equal(listed.body.summary.pendingVerification, 1)

    const confirmed = await request(app).post(`/api/admin/payments/${created.body.payment.id}/confirm`).set(admin)
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.body.payment.status, 'succeeded')
    assert.match(confirmed.body.payment.invoiceNumber, /^EC-INV-/)
    assert.equal((await Member.findById(member._id)).subscriptionStatus, 'active')
    assert.equal(String((await Payment.findById(created.body.payment.id)).confirmedBy), String(adminDoc._id))
    assert.equal(invoiceMails.length, 1)
    assert.equal((await request(app).get(`/api/payments/${created.body.payment.id}/invoice`).set(auth)).status, 200)
    const summary = await request(app).get('/api/admin/payments').set(admin)
    assert.deepEqual([summary.body.summary.succeededCount, summary.body.summary.succeededTotal], [1, AUCTION_MEMBERSHIP_PRICE])
  })

  test('an administrator can reject it with a reason; the customer can then start again', async () => {
    const { auth, member } = await customer()
    const { created } = await startAndPay(auth, transfer)
    const { auth: admin } = await adminAuth()
    const rejected = await request(app).post(`/api/admin/payments/${created.body.payment.id}/reject`).set(admin).send({ reason: 'No deposit found for that transaction ID.' })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.payment.status, 'failed')
    assert.equal(rejected.body.payment.failureMessage, 'No deposit found for that transaction ID.')
    assert.equal((await Member.findById(member._id)).subscriptionStatus, 'inactive')
    assert.equal((await start(auth)).status, 201)
  })

  test('only administrators can confirm, and only a transfer that is waiting', async () => {
    const { auth } = await customer()
    const { created } = await startAndPay(auth, transfer)
    assert.equal((await request(app).post(`/api/admin/payments/${created.body.payment.id}/confirm`).set(auth)).status, 403)
    const { auth: admin } = await adminAuth()
    await request(app).post(`/api/admin/payments/${created.body.payment.id}/confirm`).set(admin)
    assert.equal((await request(app).post(`/api/admin/payments/${created.body.payment.id}/confirm`).set(admin)).status, 409)
    assert.equal((await request(app).post(`/api/admin/payments/${new mongoose.Types.ObjectId()}/confirm`).set(admin)).status, 404)
    assert.equal((await request(app).post('/api/admin/payments/not-an-id/reject').set(admin)).status, 404)
  })

  test('an administrator cannot confirm or reject a payment that is not a transfer waiting for confirmation', async () => {
    const { auth, member } = await customer()
    const created = await start(auth)
    const { auth: admin } = await adminAuth()
    for (const action of ['confirm', 'reject']) {
      const response = await request(app).post(`/api/admin/payments/${created.body.payment.id}/${action}`).set(admin)
      assert.equal(response.status, 409)
      assert.equal(response.body.code, 'NOT_PENDING')
    }
    assert.equal((await Member.findById(member._id)).subscriptionStatus, 'inactive')
    assert.equal((await Payment.findById(created.body.payment.id)).status, 'requires_payment')
  })

  test('confirming for a customer who meanwhile became a member fails the payment instead of extending anything', async () => {
    const { auth, member } = await customer()
    const { created } = await startAndPay(auth, transfer)
    await Member.updateOne({ _id: member._id }, { $set: { subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 86_400_000) } })
    const { auth: admin } = await adminAuth()
    const response = await request(app).post(`/api/admin/payments/${created.body.payment.id}/confirm`).set(admin)
    assert.equal(response.status, 409)
    assert.equal(response.body.code, 'ALREADY_MEMBER')
    assert.equal((await Payment.findById(created.body.payment.id)).status, 'failed')
  })

  test('invalid transfer details are a field error and keep the payment open', async () => {
    const { auth } = await customer()
    const { created, paid } = await startAndPay(auth, { method: 'bank_transfer', bankTransfer: { reference: '1', date: 'x' } })
    assert.equal(paid.status, 400)
    assert.ok(paid.body.errors.bankReference)
    assert.equal((await Payment.findById(created.body.payment.id)).status, 'requires_payment')
  })
})

describe('invoices and history', () => {
  test('an invoice is built from the payment and never changes afterwards', async () => {
    const { auth, member } = await customer()
    const { paid } = await payByCard(auth)
    const id = paid.body.payment.id
    const first = (await request(app).get(`/api/payments/${id}/invoice`).set(auth)).body.invoice
    assert.equal(first.status, 'PAID')
    assert.equal(first.sandbox, true)
    assert.equal(first.seller.name, 'Executive Cars')
    assert.deepEqual([first.buyer.name, first.buyer.email], [member.name, member.email])
    assert.deepEqual(first.lineItems, [{ description: 'Annual Auction Membership (1 year)', quantity: 1, unitPrice: AUCTION_MEMBERSHIP_PRICE, amount: AUCTION_MEMBERSHIP_PRICE }])
    assert.deepEqual([first.subtotal, first.total, first.amountPaid, first.currency], [AUCTION_MEMBERSHIP_PRICE, AUCTION_MEMBERSHIP_PRICE, AUCTION_MEMBERSHIP_PRICE, 'PKR'])
    assert.equal(first.payment.methodLabel, 'Visa ending 4242')
    assert.ok(first.coverage.from && first.coverage.to)

    await Member.updateOne({ _id: member._id }, { $set: { name: 'Renamed Person', email: 'new-address@example.com' } })
    const second = (await request(app).get(`/api/payments/${id}/invoice`).set(auth)).body.invoice
    assert.deepEqual(second.buyer, first.buyer)
    assert.equal(second.invoiceNumber, first.invoiceNumber)
  })

  test('a customer sees only their own payments and invoices', async () => {
    const one = await customer(1)
    const two = await customer(2)
    const { paid } = await payByCard(one.auth)
    const id = paid.body.payment.id
    assert.equal((await request(app).get(`/api/payments/${id}`).set(two.auth)).status, 404)
    assert.equal((await request(app).get(`/api/payments/${id}/invoice`).set(two.auth)).status, 404)
    assert.equal((await pay(two.auth, id, { method: 'card', card: TEST_CARD })).status, 404)
    assert.equal((await request(app).get('/api/payments/not-an-id').set(one.auth)).status, 404)
    assert.deepEqual((await request(app).get('/api/payments').set(two.auth)).body.payments, [])
    assert.equal((await request(app).get('/api/payments').set(one.auth)).body.payments.length, 1)
  })

  test('an unpaid payment has no invoice yet', async () => {
    const { auth } = await customer()
    const created = await start(auth)
    const response = await request(app).get(`/api/payments/${created.body.payment.id}/invoice`).set(auth)
    assert.equal(response.status, 409)
    assert.equal(response.body.code, 'NO_INVOICE')
  })

  test('the invoice email names the amount, escapes the buyer name and flags a sandbox payment', async t => {
    const axios = require('axios')
    const previous = { mode: process.env.EMAIL_DELIVERY_MODE, key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL }
    process.env.EMAIL_DELIVERY_MODE = 'resend'
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.RESEND_FROM_EMAIL = 'no-reply@account.example.com'
    const originalPost = axios.post
    const sent = []
    axios.post = async (url, payload) => { sent.push(payload); return { data: { id: 'email-id' } } }
    t.after(() => { axios.post = originalPost; Object.assign(process.env, { EMAIL_DELIVERY_MODE: previous.mode, RESEND_API_KEY: previous.key, RESEND_FROM_EMAIL: previous.from }) })
    await original.invoice('buyer@example.com', {
      invoiceNumber: 'EC-INV-2026-000007', currency: 'PKR', total: 4999, sandbox: true, buyer: { name: '<i>Mallory</i>' },
      lineItems: [{ description: 'Annual Auction Membership (1 year)' }], payment: { methodLabel: 'Visa ending 4242', reference: 'EC-PAY-ABC' },
    })
    assert.equal(sent[0].subject, 'Invoice EC-INV-2026-000007 from Executive Cars')
    assert.match(sent[0].html, /PKR 4,999/)
    assert.match(sent[0].html, /no real money was charged/)
    assert.ok(!sent[0].html.includes('<i>Mallory</i>'))
  })
})

describe('the removed demo activation', () => {
  test('/payments/demo-complete and /payments/capabilities no longer exist', async () => {
    const { auth } = await customer()
    assert.equal((await request(app).post('/api/payments/demo-complete').set(auth)).status, 404)
    assert.equal((await request(app).get('/api/payments/capabilities').set(auth)).status, 404)
  })
})
