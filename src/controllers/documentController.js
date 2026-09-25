const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const mongoose = require('mongoose')
const Booking = require('../models/Booking')
const Product = require('../models/Product')
const Car = require('../models/Car')
const { cloudinary, privateUploadDir } = require('../config/cloudinary')
const { handleControllerError } = require('../utils/http')

const ACCESS_LIFETIME_SECONDS = 120

const validId = (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) return true
  res.status(400).json({ message: 'Invalid document owner identifier' })
  return false
}

const ownsRecord = (req, record, ownerField = 'ownerId') => {
  const ownerId = record?.[ownerField]
  if (ownerId && String(ownerId) === String(req.user?._id)) return true
  return Boolean(record?.sellerEmail && record.sellerEmail === req.user?.email)
}

const signLocalAccess = asset => {
  const payload = Buffer.from(JSON.stringify({
    key: asset.key,
    contentType: asset.contentType,
    extension: asset.extension || '',
    exp: Math.floor(Date.now() / 1000) + ACCESS_LIFETIME_SECONDS,
  })).toString('base64url')
  const signature = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

const verifyLocalAccess = token => {
  const [payload, signature] = String(token || '').split('.')
  if (!payload || !signature) return null
  const expected = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest()
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

const sendAccess = (req, res, asset) => {
  if (!asset?.key) return res.status(404).json({ message: 'Document is not available' })
  const expiresAt = new Date(Date.now() + ACCESS_LIFETIME_SECONDS * 1000)
  let url
  if (asset.provider === 'cloudinary') {
    url = cloudinary.utils.private_download_url(asset.key, String(asset.extension || '').replace(/^\./, ''), {
      resource_type: asset.resourceType || 'raw',
      type: 'authenticated',
      expires_at: Math.floor(expiresAt.getTime() / 1000),
    })
  } else {
    const token = signLocalAccess(asset)
    url = `${req.protocol}://${req.get('host')}/api/documents/access/${encodeURIComponent(token)}`
  }
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
    return sendAccess(req, res, asset)
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
    return sendAccess(req, res, product.inspectionDocument)
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
    return sendAccess(req, res, car.inspectionDocument)
  } catch (error) {
    return handleControllerError(res, error, 'Could not authorize inspection report access')
  }
}

const accessLocalDocument = async (req, res) => {
  const access = verifyLocalAccess(req.params.token)
  if (!access || path.basename(access.key) !== access.key) {
    return res.status(403).json({ message: 'Document link is invalid or expired' })
  }
  const absolutePath = path.resolve(privateUploadDir, access.key)
  if (!absolutePath.startsWith(`${path.resolve(privateUploadDir)}${path.sep}`)) {
    return res.status(403).json({ message: 'Document link is invalid or expired' })
  }
  try {
    await fs.promises.access(absolutePath, fs.constants.R_OK)
    res.set({
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': access.contentType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="document${String(access.extension || '').replace(/[^.a-z0-9]/gi, '')}"`,
      'X-Content-Type-Options': 'nosniff',
    })
    return fs.createReadStream(absolutePath).pipe(res)
  } catch {
    return res.status(404).json({ message: 'Document is not available' })
  }
}

module.exports = {
  getBookingDocument,
  getProductReport,
  getAuctionReport,
  accessLocalDocument,
  signLocalAccess,
  verifyLocalAccess,
}
