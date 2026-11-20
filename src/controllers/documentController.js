const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { pipeline } = require('stream')
const mongoose = require('mongoose')
const Booking = require('../models/Booking')
const Product = require('../models/Product')
const Car = require('../models/Car')
const { privateUploadDir } = require('../config/cloudinary')
const { openCloudinaryDocument } = require('../services/cloudinaryDocument')
const { handleControllerError } = require('../utils/http')
const { hmac } = require('../utils/crypto')
const { reportFileName, bookingDocumentFileName, contentDisposition } = require('../utils/documentNames')

const ACCESS_LIFETIME_SECONDS = 120

const validId = (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) return true
  res.status(400).json({ message: 'Invalid document owner identifier' })
  return false
}

// Ownership is the account the listing is assigned to. An e-mail address is not proof of ownership.
const ownsRecord = (req, record) => Boolean(record?.ownerId && String(record.ownerId) === String(req.user?._id))

const signDocumentAccess = (asset, fileName) => {
  const payload = Buffer.from(JSON.stringify({
    key: asset.key,
    provider: asset.provider || 'local',
    resourceType: asset.resourceType || 'raw',
    contentType: asset.contentType,
    extension: asset.extension || '',
    name: fileName,
    exp: Math.floor(Date.now() / 1000) + ACCESS_LIFETIME_SECONDS,
  })).toString('base64url')
  const signature = hmac('document', payload)
  return `${payload}.${signature}`
}

const verifyDocumentAccess = token => {
  const [payload, signature] = String(token || '').split('.')
  if (!payload || !signature) return null
  const expected = Buffer.from(hmac('document', payload), 'base64url')
  let received
  try { received = Buffer.from(signature, 'base64url') } catch { return null }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null
    return decoded
  } catch {
    return null
  }
}

const sendAccess = (req, res, asset, fileName) => {
  if (!asset?.key) return res.status(404).json({ message: 'Document is not available' })
  const expiresAt = new Date(Date.now() + ACCESS_LIFETIME_SECONDS * 1000)
  // Every provider is served through our own short-lived signed link, so the browser never sees the storage address.
  const token = signDocumentAccess(asset, fileName)
  // The link ends in the file name: browser PDF viewers take their title and "save as" name from the last part of the
  // address. The server ignores that part; the name that counts is the one inside the signed token.
  const url = `${req.protocol}://${req.get('host')}/api/documents/access/${encodeURIComponent(token)}/${encodeURIComponent(fileName || 'document')}`
  res.set('Cache-Control', 'no-store')
  return res.json({ url, expiresAt: expiresAt.toISOString() })
}

const getBookingDocument = async (req, res) => {
  if (!validId(req, res)) return
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ message: 'Booking not found' })
    const allowed = req.accountRole === 'admin' || String(booking.memberId) === String(req.user._id)
    if (!allowed) return res.status(403).json({ message: 'You do not have access to this document' })
    const asset = req.params.kind === 'cnic' ? booking.cnicDocument : booking.registrationDocument
    return sendAccess(req, res, asset, bookingDocumentFileName(req.params.kind, asset))
  } catch (error) {
    return handleControllerError(res, error, 'Could not authorize document access')
  }
}

const getProductReport = async (req, res) => {
  if (!validId(req, res)) return
  try {
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Product not found' })
    const signedInMarketplaceUser = req.accountRole === 'user' && req.accountModel === 'member'
    if (req.accountRole !== 'admin' && !signedInMarketplaceUser && !ownsRecord(req, product)) {
      return res.status(403).json({ message: 'You do not have access to this document' })
    }
    return sendAccess(req, res, product.inspectionDocument, reportFileName(product))
  } catch (error) {
    return handleControllerError(res, error, 'Could not authorize inspection report access')
  }
}

const getAuctionReport = async (req, res) => {
  if (!validId(req, res)) return
  try {
    const car = await Car.findById(req.params.id)
    if (!car) return res.status(404).json({ message: 'Auction not found' })
    const activeMember = req.accountRole === 'user' && req.accountModel === 'member' && req.user.hasActiveSubscription()
    if (req.accountRole !== 'admin' && !activeMember && !ownsRecord(req, car)) {
      return res.status(403).json({ message: 'You do not have access to this document' })
    }
    return sendAccess(req, res, car.inspectionDocument, reportFileName(car))
  } catch (error) {
    return handleControllerError(res, error, 'Could not authorize inspection report access')
  }
}

const invalidLink = res => res.status(403).json({ message: 'Document link is invalid or expired' })

const setDocumentHeaders = (res, access) => res.set({
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Type': access.contentType || 'application/octet-stream',
  'Content-Disposition': contentDisposition(access.name || `document${String(access.extension || '').replace(/[^.a-z0-9]/gi, '')}`),
  'X-Content-Type-Options': 'nosniff',
})

// A browser that closes the tab or drops the connection is normal, not a failure worth logging.
const BROWSER_LEFT = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE'])
const logStreamFailure = error => {
  if (error && !BROWSER_LEFT.has(error.code)) console.warn(JSON.stringify({ event: 'document_stream_failure', code: error.code || 'stream_error' }))
}

const sendLocalDocument = async (res, access) => {
  if (path.basename(access.key) !== access.key) return invalidLink(res)
  const absolutePath = path.resolve(privateUploadDir, access.key)
  if (!absolutePath.startsWith(`${path.resolve(privateUploadDir)}${path.sep}`)) return invalidLink(res)
  try {
    await fs.promises.access(absolutePath, fs.constants.R_OK)
    setDocumentHeaders(res, access)
    // pipeline, unlike pipe, handles a read error instead of letting it take the process down.
    return pipeline(fs.createReadStream(absolutePath), res, logStreamFailure)
  } catch {
    return res.status(404).json({ message: 'Document is not available' })
  }
}

const sendCloudinaryDocument = async (res, access) => {
  // If the browser leaves while we still wait for the storage, the fetch is stopped too.
  const browserLeft = new AbortController()
  res.on('close', () => browserLeft.abort())
  let stream
  try {
    const opened = await openCloudinaryDocument(access, { signal: browserLeft.signal })
    stream = opened.stream
    setDocumentHeaders(res, access)
    if (opened.contentLength) res.set('Content-Length', String(opened.contentLength))
    res.on('close', () => stream.destroy())
    return pipeline(stream, res, logStreamFailure)
  } catch (error) {
    stream?.destroy()
    return res.status(error.status === 404 ? 404 : 502).json({ message: error.status === 404 ? error.message : 'Document storage is not reachable' })
  }
}

const accessDocument = async (req, res) => {
  const access = verifyDocumentAccess(req.params.token)
  if (!access) return invalidLink(res)
  // A HEAD request only asks for the headers: it never downloads the file from storage.
  if (req.method === 'HEAD') return setDocumentHeaders(res, access).end()
  return access.provider === 'cloudinary' ? sendCloudinaryDocument(res, access) : sendLocalDocument(res, access)
}

module.exports = {
  getBookingDocument,
  getProductReport,
  getAuctionReport,
  accessDocument,
  signDocumentAccess,
  verifyDocumentAccess,
}
