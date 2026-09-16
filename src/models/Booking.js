const mongoose = require('mongoose')
const privateAssetSchema = require('./privateAssetSchema')
const {
  isValidCnic,
  isValidPersonName,
  isValidPhone,
  normalizeCnic,
  normalizePersonName,
  normalizePhone,
} = require('../utils/inputValidation')

const bookingSchema = new mongoose.Schema({
  memberId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Member', index: true },
  name:         { type: String, required: true, trim: true, set: normalizePersonName, validate: { validator: isValidPersonName, message: 'Name must contain letters only' } },
  email:        { type: String, required: true, lowercase: true, trim: true },
  phone:        { type: String, required: true, trim: true, set: normalizePhone, validate: { validator: isValidPhone, message: 'Phone must contain 10 to 15 digits' } },
  cnic:         { type: String, trim: true, set: normalizeCnic, validate: { validator: value => !value || isValidCnic(value), message: 'CNIC must use XXXXX-XXXXXXX-X format' } },
  carMake:      { type: String, required: true, trim: true },
  carModel:     { type: String, required: true, trim: true },
  carYear:      { type: String, trim: true, validate: { validator: value => !value || /^\d{4}$/.test(value), message: 'Vehicle year must contain four digits' } },
  mileage:      { type: String, trim: true, validate: { validator: value => !value || /^\d+$/.test(value), message: 'Mileage must contain digits only' } },
  engineCC:     { type: String, trim: true, validate: { validator: value => !value || /^\d+$/.test(value), message: 'Engine capacity must contain digits only' } },
  cnicImageUrl: { type: String },
  regDocUrl:    { type: String },
  cnicDocument: { type: privateAssetSchema },
  registrationDocument: { type: privateAssetSchema },
  date:         { type: String, required: true },
  time:         { type: String, trim: true },
  branch:       { type: String, required: true },
  notes:        { type: String, trim: true, maxlength: 500 },
  status:       { type: String, enum: ['pending', 'approved', 'rejected', 'confirmed', 'completed', 'cancelled'], default: 'pending' },
  sellerCreated:{ type: Boolean, default: false },
  demoKey:      { type: String, sparse: true, index: true },
}, { timestamps: true })

module.exports = mongoose.model('Booking', bookingSchema)
