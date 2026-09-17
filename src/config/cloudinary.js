const cloudinary = require('cloudinary').v2
const multer = require('multer')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const credentials = [process.env.CLOUDINARY_CLOUD_NAME, process.env.CLOUDINARY_API_KEY, process.env.CLOUDINARY_API_SECRET]
const usingCloudinary = credentials.every(value => value && !/^(your_|local-development)/i.test(value))

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const publicImageDir = path.join(__dirname, '..', '..', 'uploads', 'public', 'images')
const privateUploadDir = path.join(__dirname, '..', '..', 'private-uploads')
if (!usingCloudinary) {
  fs.mkdirSync(publicImageDir, { recursive: true })
  fs.mkdirSync(privateUploadDir, { recursive: true })
}

const extensionByMime = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
}

const localStorage = multer.diskStorage({
  destination(req, file, callback) {
    callback(null, file.fieldname === 'images' ? publicImageDir : privateUploadDir)
  },
  filename(req, file, callback) {
    callback(null, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${extensionByMime[file.mimetype] || ''}`)
  },
})

const fileFilter = (req, file, callback) => {
  const isPdf = file.mimetype === 'application/pdf'
  const isImage = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
  const allowed = file.fieldname === 'report' ? isPdf : (isImage || (file.fieldname === 'regDoc' && isPdf))
  const error = allowed ? null : Object.assign(new Error('Only JPG, PNG, WEBP images and PDF documents are allowed'), { status: 400 })
  callback(error, allowed)
}

const options = storage => ({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024, files: 7 } })
const carFields = [{ name: 'images', maxCount: 6 }, { name: 'report', maxCount: 1 }]
const documentFields = [{ name: 'cnicImage', maxCount: 1 }, { name: 'regDoc', maxCount: 1 }]

const hasExpectedSignature = (buffer, mime) => {
  if (!buffer || buffer.length < 4) return false
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (mime === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mime === 'image/webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
  if (mime === 'application/pdf') return buffer.subarray(0, 5).toString() === '%PDF-'
  return false
}

const validateMagicBytes = async file => {
  const buffer = file.buffer || await fs.promises.readFile(file.path)
  if (!hasExpectedSignature(buffer, file.mimetype)) {
    throw Object.assign(new Error(`Uploaded ${file.fieldname} content does not match its declared file type`), { status: 400 })
  }
}

const cleanLocalFiles = files => Promise.all(files.filter(file => file.path).map(file => fs.promises.unlink(file.path).catch(() => {})))

const deleteUploadedFile = async file => {
  if (!file) return
  if (file.assetProvider === 'cloudinary' && file.filename) {
    await cloudinary.uploader.destroy(file.filename, {
      resource_type: file.resourceType || (file.mimetype === 'application/pdf' ? 'raw' : 'image'),
      type: file.fieldname === 'images' ? 'upload' : 'authenticated',
      invalidate: true,
    })
    return
  }
  if (file.path) await fs.promises.unlink(file.path).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
}

const cleanUploadedFiles = files => Promise.all(files.map(deleteUploadedFile))

const cleanUploadsAfterFailedResponse = (res, files) => {
  res.once('finish', () => {
    if (res.statusCode < 400) return
    cleanUploadedFiles(files).catch(error => {
      console.warn(JSON.stringify({ event: 'upload_cleanup_failure', category: error.code || 'storage_error' }))
    })
  })
}

const uploadBuffer = (file, uploadOptions) => new Promise((resolve, reject) => {
  const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
    if (error) return reject(error)
    file.path = file.fieldname === 'images' ? result.secure_url : ''
    file.filename = result.public_id
    file.assetProvider = 'cloudinary'
    file.resourceType = result.resource_type
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
      await Promise.all(files.map(validateMagicBytes))
      await Promise.all(files.map(file => uploadBuffer(file, getOptions(file))))
      cleanUploadsAfterFailedResponse(res, files)
      return next()
    } catch (uploadError) {
      await cleanUploadedFiles(Object.values(req.files || {}).flat()).catch(() => {})
      if (!uploadError.status) uploadError.status = 502
      return next(uploadError)
    }
  })
}

const localMiddleware = fields => {
  const parse = multer(options(localStorage)).fields(fields)
  return (req, res, next) => parse(req, res, async parseError => {
    if (parseError) return next(parseError)
    const files = Object.values(req.files || {}).flat()
    try {
      await Promise.all(files.map(validateMagicBytes))
      files.forEach(file => {
        file.assetProvider = 'local'
        file.resourceType = file.mimetype === 'application/pdf' ? 'raw' : 'image'
      })
      cleanUploadsAfterFailedResponse(res, files)
      return next()
    } catch (validationError) {
      await cleanLocalFiles(files)
      return next(validationError)
    }
  })
}

const carUpload = usingCloudinary
  ? cloudinaryMiddleware(carFields, file => file.fieldname === 'report'
      ? { folder: 'executive-cars/reports', resource_type: 'raw', type: 'authenticated' }
      : { folder: 'executive-cars/images', resource_type: 'image', transformation: [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }] })
  : localMiddleware(carFields)

const docUpload = usingCloudinary
  ? cloudinaryMiddleware(documentFields, file => ({
      folder: 'executive-cars/documents',
      resource_type: file.mimetype === 'application/pdf' ? 'raw' : 'image',
      type: 'authenticated',
    }))
  : localMiddleware(documentFields)

const uploadedFileUrl = (req, file) => {
  if (!file) return ''
  if (file.fieldname !== 'images') throw Object.assign(new Error('Private documents cannot be exposed as permanent URLs'), { status: 500 })
  if (/^https?:\/\//i.test(file.path || '')) return file.path
  return `${req.protocol}://${req.get('host')}/uploads/images/${encodeURIComponent(file.filename)}`
}

const storedPrivateAsset = file => file ? {
  provider: file.assetProvider || (usingCloudinary ? 'cloudinary' : 'local'),
  key: file.filename,
  resourceType: file.resourceType || (file.mimetype === 'application/pdf' ? 'raw' : 'image'),
  contentType: file.mimetype,
  size: file.size,
  extension: extensionByMime[file.mimetype] || '',
  uploadedAt: new Date(),
} : undefined

const deletePrivateAsset = async asset => {
  if (!asset?.key) return
  if (asset.provider === 'cloudinary') {
    await cloudinary.uploader.destroy(asset.key, {
      resource_type: asset.resourceType || 'raw',
      type: 'authenticated',
      invalidate: true,
    })
    return
  }
  if (path.basename(asset.key) !== asset.key) return
  await fs.promises.unlink(path.join(privateUploadDir, asset.key)).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
}

module.exports = {
  cloudinary,
  usingCloudinary,
  carUpload,
  docUpload,
  uploadedFileUrl,
  storedPrivateAsset,
  deletePrivateAsset,
  publicImageDir,
  privateUploadDir,
  hasExpectedSignature,
}
