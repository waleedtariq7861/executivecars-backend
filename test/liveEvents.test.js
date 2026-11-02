process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length'
process.env.CLIENT_URL = 'http://127.0.0.1:5173'
process.env.ML_API_URL = ''
process.env.EMAIL_DELIVERY_MODE = 'smtp'
process.env.ENABLE_DEMO_SEED = 'true'
const { DEFAULT_TEST_URI, validateTestUri, connectTestDatabase, dropTestDatabase, resetTestDatabase } = require('./helpers/localDatabase')
process.env.MONGO_URI = validateTestUri(process.env.TEST_MONGO_URI || DEFAULT_TEST_URI)
for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GROQ_API_KEY', 'ML_SERVICE_KEY', 'RESEND_API_KEY']) process.env[key] = ''

const { before, after, beforeEach, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const mongoose = require('mongoose')
require('./helpers/noRateLimits')
const request = require('supertest')
require('./helpers/cookieAuth')
const { createApp } = require('../server/app')
const Admin = require('../src/models/Admin')
const Car = require('../src/models/Car')
const Member = require('../src/models/Member')
const { closeExpiredAuctions } = require('../src/utils/auctionScheduler')
const { emitAuctionEnded, emitBidUpdate } = require('../src/utils/auctionEvents')
const { maskBidderName } = require('../src/utils/publicDto')

let sent
// Records every emit with the rooms it targets and the rooms it leaves out, like a Socket.IO server would deliver it.
const fakeIo = () => ({
  to: (...rooms) => {
    const names = rooms.flat()
    const exceptRooms = []
    const chain = {
      except(name) { exceptRooms.push(name); return chain },
      emit(event, payload) { sent.push({ rooms: names, except: [...exceptRooms], event, payload }) },
    }
    return chain
  },
})

const person = { name: 'Quiet Bidder', email: 'quiet-bidder@example.com', phone: '+92 300 5550701', password: 'orchid-lantern-42' }
const rival = { name: 'Rival Bidder', email: 'rival-bidder@example.com', phone: '+92 300 5550702', password: 'orchid-lantern-43' }
let app

before(async () => {
  await connectTestDatabase()
})

after(async () => {
  if (mongoose.connection.readyState === 1) {
    try { await dropTestDatabase() } finally { await mongoose.disconnect() }
  }
})

beforeEach(async () => {
  await resetTestDatabase()
  sent = []
  app = createApp({ io: fakeIo() })
})

const member = async (account) => {
  const body = (await request(app).post('/api/auth/register').send(account)).body
  const record = await Member.findOne({ email: account.email })
  await Member.updateOne({ _id: record._id }, { $set: { subscriptionStatus: 'active', subscriptionExpiry: new Date(Date.now() + 30 * 86_400_000), emailVerifiedAt: new Date() } })
  return { token: body.token, record: await Member.findById(record._id) }
}
const auction = (overrides = {}) => Car.create({
  make: 'Honda', model: 'Civic', year: 2021, km: 20000, engine: '1800', basePrice: 4_000_000, currentBid: 4_000_000,
  auctionStart: new Date(Date.now() - 3_600_000), auctionEnd: new Date(Date.now() + 86_400_000), ...overrides,
})
const asBearer = token => ({ Authorization: `Bearer ${token}` })
const everything = () => JSON.stringify(sent)

describe('masking a bidder', () => {
  test('keeps two letters and hides the rest', () => {
    assert.equal(maskBidderName('Quiet Bidder'), 'Qu***')
    assert.equal(maskBidderName('  Al  '), 'Al***')
    assert.equal(maskBidderName(''), 'Bidder')
    assert.equal(maskBidderName(undefined), 'Bidder')
  })
})

describe('a new bid', () => {
  test('tells the bidder it is theirs and everyone else only a masked name, with no account id', () => {
    const io = fakeIo()
    const bidder = { _id: new mongoose.Types.ObjectId(), name: 'Quiet Bidder' }
    emitBidUpdate(io, { carId: 'car-1', bidAmount: 4_100_000, bidder, bidCount: 3 })
    assert.equal(sent.length, 2)
    const personal = sent.find(item => item.rooms.includes(`user-${bidder._id}`))
    const room = sent.find(item => item.rooms.includes('car-1'))
    assert.deepEqual(personal.payload, { carId: 'car-1', currentBid: 4_100_000, bidCount: 3, highestBidder: { isMe: true, name: 'You' } })
    assert.deepEqual(room.except, [`user-${bidder._id}`], 'the bidder is not sent the room copy as well')
    assert.deepEqual(room.payload, { carId: 'car-1', currentBid: 4_100_000, bidCount: 3, highestBidder: { name: 'Qu***' } })
    assert.ok(!JSON.stringify(room.payload).includes('Quiet') && !JSON.stringify(room.payload).includes(String(bidder._id)))
  })

  test('does nothing when no server is attached', () => {
    assert.doesNotThrow(() => emitBidUpdate(undefined, { carId: 'c', bidAmount: 1, bidder: { _id: 'b', name: 'X' }, bidCount: 1 }))
  })

  test('over the API: the room never receives a name or id, the outbid person is told, and the bid still works', async () => {
    const first = await member(person)
    const second = await member(rival)
    const car = await auction()
    assert.equal((await request(app).post('/api/bids').set(asBearer(first.token)).send({ carId: String(car._id), amount: 4_100_000 })).status, 201)
    sent = []
    const response = await request(app).post('/api/bids').set(asBearer(second.token)).send({ carId: String(car._id), amount: 4_200_000 })
    assert.equal(response.status, 201)
    const updates = sent.filter(item => item.event === 'bid-update')
    assert.equal(updates.length, 2)
    for (const update of updates) assert.ok(!JSON.stringify(update.payload).includes('Rival'), 'no full name in any copy')
    const roomCopy = updates.find(item => item.rooms.includes(String(car._id)))
    assert.deepEqual(roomCopy.payload.highestBidder, { name: 'Ri***' })
    assert.ok(sent.every(item => !JSON.stringify(item.payload).includes(String(second.record._id))), 'no account id in a payload')
    const outbid = sent.find(item => item.event === 'outbid')
    assert.deepEqual(outbid.rooms, [`user-${first.record._id}`])
    assert.deepEqual(outbid.payload, { carId: String(car._id), newBid: 4_200_000 })
  })
})

describe('the end of an auction', () => {
  const ended = (overrides = {}) => ({ _id: new mongoose.Types.ObjectId(), currentBid: 4_500_000, reservePrice: 4_000_000, highestBidder: { _id: new mongoose.Types.ObjectId(), name: 'Quiet Bidder' }, ...overrides })

  test('tells the winner they won and everyone else only a masked name', () => {
    const car = ended()
    emitAuctionEnded(fakeIo(), car)
    const personal = sent.find(item => item.rooms.includes(`user-${car.highestBidder._id}`))
    const room = sent.find(item => item.rooms.includes(String(car._id)))
    assert.deepEqual(personal.payload, { carId: String(car._id), finalBid: 4_500_000, reserveMet: true, winner: { isMe: true, name: 'You' } })
    assert.deepEqual(room.except, [`user-${car.highestBidder._id}`])
    assert.deepEqual(room.payload, { carId: String(car._id), finalBid: 4_500_000, reserveMet: true, winner: { name: 'Qu***' } })
    assert.ok(!JSON.stringify(room.payload).includes('Quiet'))
  })

  test('names nobody when the reserve was not met or nobody bid', () => {
    emitAuctionEnded(fakeIo(), ended({ currentBid: 3_000_000 }))
    emitAuctionEnded(fakeIo(), ended({ highestBidder: undefined }))
    assert.equal(sent.length, 2)
    for (const item of sent) {
      assert.equal(item.payload.winner, null)
      assert.deepEqual(item.except, [])
    }
    assert.equal(sent[0].payload.reserveMet, false)
  })

  test('a bidder who is only an id (not loaded) still wins correctly', () => {
    const winnerId = new mongoose.Types.ObjectId()
    emitAuctionEnded(fakeIo(), ended({ highestBidder: winnerId }))
    assert.equal(sent.length, 2)
    assert.ok(sent.some(item => item.rooms.includes(`user-${winnerId}`) && item.payload.winner.isMe))
    assert.ok(sent.some(item => item.payload.winner.name === 'Bidder'))
  })

  test('the scheduler and an administrator closing early both use it', async () => {
    const { record } = await member(person)
    const finished = await auction({ currentBid: 4_500_000, reservePrice: 4_000_000, highestBidder: record._id, auctionStart: new Date(Date.now() - 86_400_000), auctionEnd: new Date(Date.now() - 1000) })
    await closeExpiredAuctions(fakeIo())
    assert.equal(sent.length, 2)
    assert.ok(!everything().includes('Quiet Bidder'))
    assert.ok(sent.some(item => item.rooms.includes(`user-${record._id}`) && item.payload.winner.isMe))

    sent = []
    await Admin.create({ name: 'Live Admin', email: 'live-admin@example.com', password: 'admin-pass-123', role: 'admin' })
    const admin = (await request(app).post('/api/auth/admin/login').send({ email: 'live-admin@example.com', password: 'admin-pass-123' })).body.token
    const running = await auction({ currentBid: 4_600_000, reservePrice: 4_000_000, highestBidder: record._id })
    const closed = await request(app).post(`/api/admin/cars/${running._id}/close`).set(asBearer(admin))
    assert.equal(closed.status, 200)
    assert.ok(!everything().includes('Quiet Bidder'))
    assert.ok(sent.some(item => item.event === 'auction-ended' && item.payload.winner?.isMe))
    assert.ok(finished)
  })
})
