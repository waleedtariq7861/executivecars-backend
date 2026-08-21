const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const { isValidPersonName, isValidPhone, normalizePersonName, normalizePhone } = require('../utils/inputValidation')

const adminSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true, set: normalizePersonName, validate: { validator: isValidPersonName, message: 'Name must contain letters only' } },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 8 },
  phone:    { type: String, trim: true, set: normalizePhone, validate: { validator: value => !value || isValidPhone(value), message: 'Phone must contain 10 to 15 digits' } },
  role:     { type: String, enum: ['admin'], default: 'admin' },
  demoKey:  { type: String, sparse: true, index: true },
}, { timestamps: true })

adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

adminSchema.methods.matchPassword = function (plain) {
  return bcrypt.compare(plain, this.password)
}

module.exports = mongoose.model('Admin', adminSchema)
