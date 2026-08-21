const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const {
  isValidCnic,
  isValidPersonName,
  isValidPhone,
  normalizeCnic,
  normalizePersonName,
  normalizePhone,
} = require('../utils/inputValidation')

const sellerSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true, set: normalizePersonName, validate: { validator: isValidPersonName, message: 'Name must contain letters only' } },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true, minlength: 8 },
  phone:     { type: String, trim: true, set: normalizePhone, validate: { validator: value => !value || isValidPhone(value), message: 'Phone must contain 10 to 15 digits' } },
  cnic:      { type: String, trim: true, set: normalizeCnic, validate: { validator: value => !value || isValidCnic(value), message: 'CNIC must use XXXXX-XXXXXXX-X format' } },
  address:   { type: String, trim: true },
  role:      { type: String, enum: ['seller'], default: 'seller' },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
}, { timestamps: true })

sellerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

sellerSchema.methods.matchPassword = function (plain) {
  return bcrypt.compare(plain, this.password)
}

module.exports = mongoose.model('Seller', sellerSchema)
