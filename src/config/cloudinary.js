const cloudinary = require('cloudinary').v2
const multer = require('multer')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const credentials = [
  process.env.CLOUDINARY_CLOUD_NAME,
  process.env.CLOUDINARY_API_KEY,
  process.env.CLOUDINARY_API_SECRET,
]
const usingCloudinary = credentials.every(value => value && !/^(your_|local-development)/i.test(value))

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const uploadDir = path.join(__dirname, '..', '..', 'uploads')
if (!usingCloudinary) fs.mkdirSync(uploadDir, { recursive: true })

const localStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')
    callback(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`)
  },
})

const fileFilter = (req, file, callback) => {
  const isPdf = file.mimetype === 'application/pdf'
  const isImage = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
  const allowed = file.fieldname === 'report' ? isPdf : (isImage || (file.fieldname === 'regDoc' && isPdf))
  callback(allowed ? null : new Error('Only JPG, PNG, WEBP images and PDF documents are allowed'), allowed)
}

const options = (storage) => ({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024, files: 7 } })
const carFields = [
  { name: 'images', maxCount: 6 },
  { name: 'report', maxCount: 1 },
]
const documentFields = [
  { name: 'cnicImage', maxCount: 1 },
  { name: 'regDoc', maxCount: 1 },
]

const uploadBuffer = (file, uploadOptions) => new Promise((resolve, reject) => {
  const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
    if (error) return reject(error)
    file.path = result.secure_url
    file.filename = result.public_id
    return resolve(file)
  })
  stream.end(file.buffer)
})

const cloudinaryMiddleware = (fields, getOptions) => {
  const parse = multer(options(multer.memoryStorage())).fields(fields)
  return (req, res, next) => parse(req, res, async parseError => {
    if (parseError) return next(parseError)
    try {
      const files = Object.values(req.files || {}).flat()
      await Promise.all(files.map(file => uploadBuffer(file, getOptions(file))))
      return next()
    } catch (uploadError) {
      uploadError.status = 502
      return next(uploadError)
    }
  })
}

const carUpload = usingCloudinary
  ? cloudinaryMiddleware(carFields, file => file.fieldname === 'report'
      ? { folder: 'executive-cars/reports', resource_type: 'raw' }
      : { folder: 'executive-cars/images', resource_type: 'image', transformation: [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }] })
  : multer(options(localStorage)).fields(carFields)

const docUpload = usingCloudinary
  ? cloudinaryMiddleware(documentFields, file => ({
      folder: 'executive-cars/documents',
      resource_type: file.mimetype === 'application/pdf' ? 'raw' : 'image',
    }))
  : multer(options(localStorage)).fields(documentFields)

const uploadedFileUrl = (req, file) => {
  if (!file) return ''
  if (/^https?:\/\//i.test(file.path || '')) return file.path
  return `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(file.filename)}`
}

module.exports = {
  cloudinary,
  usingCloudinary,
  carUpload,
  docUpload,
  uploadedFileUrl,
  uploadDir,
}
