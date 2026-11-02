const { after, test } = require('node:test')
const assert = require('node:assert/strict')
const mongoose = require('mongoose')
const Member = require('../src/models/Member')
const sessions = require('../src/utils/sessions')
const initSocket = require('../src/socket/bidSocket')

const originalFindById = Member.findById
const originalFindValidSession = sessions.findValidSession
const originalIsSessionActive = sessions.isSessionActive

let lookup = async () => null
Member.findById = id => ({ select: () => lookup(id) })

// Sessions are stubbed so these tests stay database-free: "session:<accountId>:<role>" is a valid token.
let sessionActive = true
const sessionIds = new Map()
sessions.findValidSession = async token => {
  const [, accountId, role] = String(token).match(/^session:(\w+):(\w+)$/) || []
  if (!accountId) return { code: sessions.CODES.missing }
  if (!sessionIds.has(token)) sessionIds.set(token, new mongoose.Types.ObjectId())
  return { session: { _id: sessionIds.get(token), accountId, role: role === 'admin' ? 'admin' : 'user', accountModel: role === 'admin' ? 'admin' : 'member' } }
}
sessions.isSessionActive = async () => sessionActive

after(() => {
  Member.findById = originalFindById
  sessions.findValidSession = originalFindValidSession
  sessions.isSessionActive = originalIsSessionActive
})

const member = (status = 'active', expiry = Date.now() + 60_000) => new Member({
  _id: new mongoose.Types.ObjectId(),
  subscriptionStatus: status,
  subscriptionExpiry: new Date(expiry),
})

const tokenFor = (id, role = 'user') => `session:${id.toString()}:${role}`

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

test('socket connections require a valid session and an active member record', async () => {
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
  assert.equal(valid.rooms.has(`user-${active.id}`), true)
  // every socket also joins a room named after its session so a revoked session can be cut off
  assert.equal([...valid.rooms].some(room => room.startsWith('session-')), true)
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

  sessionActive = false
  await socket.trigger('join-auction', new mongoose.Types.ObjectId().toString())
  assert.equal(socket.disconnected, true)
  sessionActive = true

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

const withHeaders = (socket, headers) => { Object.assign(socket.handshake.headers, headers); return socket }

test('a page on another site cannot open an auction socket with the visitor\'s cookie', async () => {
  const io = server()
  const active = member()
  lookup = async () => active
  const foreign = withHeaders(socketFor(tokenFor(active.id)), { origin: 'https://evil.example' })
  assert.match((await connect(io, foreign)).message, /Origin not allowed/)
  const own = withHeaders(socketFor(tokenFor(active.id)), { origin: 'http://127.0.0.1:5173/' })
  assert.equal(await connect(io, own), undefined)
  own.disconnect()
  const withoutOrigin = socketFor(tokenFor(active.id))
  assert.equal(await connect(io, withoutOrigin), undefined, 'a client that is not a browser sends no origin and has no victim cookie')
  withoutOrigin.disconnect()
})

test('a session token handed over by page script is not accepted, only the cookie is', async () => {
  const io = server()
  const active = member()
  lookup = async () => active
  const socket = socketFor(null)
  socket.handshake.auth = { token: tokenFor(active.id) }
  assert.match((await connect(io, socket)).message, /Authentication required/)
})

const objectIds = count => Array.from({ length: count }, () => new mongoose.Types.ObjectId().toString())

test('one connection follows at most twenty auctions', async t => {
  const io = server()
  const active = member('active', Date.now() + 3_600_000)
  lookup = async () => active
  const socket = socketFor(tokenFor(active.id))
  await connect(io, socket)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const ids = objectIds(22)
  for (const id of ids.slice(0, 20)) await socket.trigger('join-auction', id)
  assert.equal(ids.slice(0, 20).every(id => socket.rooms.has(id)), true)
  now += 11_000
  await socket.trigger('join-auction', ids[20])
  assert.equal(socket.rooms.has(ids[20]), false, 'the twenty-first room is refused')
  await socket.trigger('join-auction', ids[0])
  assert.equal(socket.rooms.has(ids[0]), true, 'a room already followed can be joined again')
  await socket.trigger('leave-auction', ids[1])
  await socket.trigger('join-auction', ids[21])
  assert.equal(socket.rooms.has(ids[21]), true, 'leaving one makes room for another')
  socket.disconnect()
})

test('join requests are limited in rate, so a connection cannot make the server look up the account without end', async t => {
  const io = server()
  const active = member('active', Date.now() + 3_600_000)
  let lookups = 0
  lookup = async () => { lookups += 1; return active }
  const socket = socketFor(tokenFor(active.id))
  await connect(io, socket)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const ids = objectIds(25)
  const before = lookups
  for (const id of ids) {
    await socket.trigger('join-auction', id)
    await socket.trigger('leave-auction', id)
  }
  assert.equal(lookups - before, 20, 'only twenty of the twenty-five requests did any work')
  now += 11_000
  await socket.trigger('join-auction', ids[24])
  assert.equal(socket.rooms.has(ids[24]), true, 'the allowance renews')
  socket.disconnect()
})

test('anything that is not a 24-character auction id is ignored', async () => {
  const io = server()
  const active = member()
  lookup = async () => active
  const socket = socketFor(tokenFor(active.id))
  await connect(io, socket)
  for (const value of [undefined, null, 42, {}, ['a'], '123456789012', 'z'.repeat(24), 'a'.repeat(23)]) {
    await socket.trigger('join-auction', value)
    await socket.trigger('leave-auction', value)
  }
  assert.deepEqual([...socket.rooms].filter(room => !room.startsWith('user-') && !room.startsWith('session-')), [])
  socket.disconnect()
})
