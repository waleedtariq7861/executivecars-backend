const mongoose = require('mongoose')

// Private assets store provider identifiers rather than permanent delivery
// URLs. Access is granted through the authenticated document controller.
const privateAssetSchema = new mongoose.Schema({
  provider: { type: String, enum: ['local', 'cloudinary'], required: true },
  key: { type: String, required: true },
  resourceType: { type: String, enum: ['image', 'raw'], required: true },
  contentType: { type: String, required: true },
  size: { type: Number, min: 0, required: true },
  extension: { type: String, trim: true },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false })

module.exports = privateAssetSchema
