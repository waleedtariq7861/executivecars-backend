const multer = require('multer')

const datasetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const allowed = /\.(csv|json)$/i.test(file.originalname) && ['text/csv', 'application/csv', 'application/json', 'text/plain'].includes(file.mimetype)
    callback(allowed ? null : new Error('Upload a CSV or JSON file up to 10 MB'), allowed)
  },
})

module.exports = datasetUpload
