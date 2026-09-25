const { after, test } = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const mongoose = require('mongoose')
const Member = require('../src/models/Member')
const initSocket = require('../src/socket/bidSocket')

const previousSecret = process.env.JWT_SECRET
const originalFindById = Member.findById
process.env.JWT_SECRET = 'socket-test-secret'

let lookup = async () => null
Member.findById = id => ({ select: () => lookup(id) })

after(() => {
  Member.findById = originalFindById
  if (previousSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = previousSecret
})

const member = (status = 'active', expiry = Date.now() + 60_000) => new Member({
  _id: new mongoose.Types.ObjectId(),
  subscriptionStatus: status,
  subscriptionExpiry: new Date(expiry),
})

const tokenFor = (id, role = 'user') => jwt.sign({ id: id.toString(), role }, process.env.JWT_SECRET, { expiresIn: '1h' })

const socketFor = token => {
  const handlers = new Map()
  const rooms = new Set()
  return {
    handshake: { headers: token ? { cookie: `ec_session=${token}` } : {}, auth: {} },
    handlers,
    rooms,
    disconnected: false,
    join(room) { rooms.add(room) },
    leave(room) { rooms.delete(room) },
    on(event, handler) { handlers.set(event, handler) },
    async trigger(event, value) { return handlers.get(event)?.(value) },
    disconnect() {
      this.disconnected = true
      rooms.clear()
      handlers.get('disconnect')?.()
    },
  }
}

const server = () => {
  const io = { use(handler) { this.authenticate = handler }, on(event, handler) { this[event] = handler } }
  initSocket(io)
  return io
}

const connect = async (io, socket) => {
  const error = await new Promise(resolve => io.authenticate(socket, resolve))
  if (!error) io.connection(socket)
  return error
}

test('socket connections require a valid token and an active member record', async () => {
  const io = server()
  const active = member()
  const inactive = member('inactive')
  lookup = async id => id === active.id ? active : id === inactive.id ? inactive : null

  assert.match((await connect(io, socketFor(null))).message, /Authentication required/)
  assert.match((await connect(io, socketFor('invalid'))).message, /Invalid token/)
  assert.match((await connect(io, socketFor(tokenFor(active.id, 'admin')))).message, /Active membership required/)
  assert.match((await connect(io, socketFor(tokenFor(inactive.id)))).message, /Active membership required/)
  assert.match((await connect(io, socketFor(tokenFor(new mongoose.Types.ObjectId())))).message, /Active membership required/)

  const valid = socketFor(tokenFor(active.id))
  assert.equal(await connect(io, valid), undefined)
  assert.deepEqual([...valid.rooms], [`user-${active.id}`])
  valid.disconnect()
})

test('auction rooms require a current membership and can be left', async () => {
  const io = server()
  const active = member()
  lookup = async () => active
  const socket = socketFor(tokenFor(active.id))
  await connect(io, socket)

  const carId = new mongoose.Types.ObjectId().toString()
  await socket.trigger('join-auction', 'invalid')
  assert.equal(socket.rooms.has('invalid'), false)
  await socket.trigger('join-auction', carId)
  assert.equal(socket.rooms.has(carId), true)
  await socket.trigger('leave-auction', carId)
  assert.equal(socket.rooms.has(carId), false)
  socket.disconnect()
})

test('revoked membership disconnects a socket before another auction join', async () => {
  const io = server()
  const active = member()
  lookup = async () => active
  const socket = socketFor(tokenFor(active.id))
  await connect(io, socket)

  active.subscriptionStatus = 'inactive'
  await socket.trigger('join-auction', new mongoose.Types.ObjectId().toString())
  assert.equal(socket.disconnected, true)
  assert.equal(socket.rooms.size, 0)
})

test('expired memberships and sessions cannot keep auction room access', async () => {
  const io = server()
  const active = member()
  lookup = async () => active
  const socket = socketFor(tokenFor(active.id))
  await connect(io, socket)

  socket.sessionExpiresAt = Date.now() - 1
  await socket.trigger('join-auction', new mongoose.Types.ObjectId().toString())
  assert.equal(socket.disconnected, true)

  const expired = member('active', Date.now() - 1)
  lookup = async () => expired
  assert.match((await connect(io, socketFor(tokenFor(expired.id)))).message, /Active membership required/)
})

test('leaving while membership lookup is pending does not rejoin the auction', async () => {
  const io = server()
  const active = member()
  lookup = async () => active
  const socket = socketFor(tokenFor(active.id))
  await connect(io, socket)

  let releaseLookup
  lookup = () => new Promise(resolve => { releaseLookup = () => resolve(active) })
  const carId = new mongoose.Types.ObjectId().toString()
  const joining = socket.trigger('join-auction', carId)
  await socket.trigger('leave-auction', carId)
  releaseLookup()
  await joining
  assert.equal(socket.rooms.has(carId), false)
  socket.disconnect()
})
