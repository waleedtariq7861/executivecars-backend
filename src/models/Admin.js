const mongoose = require('mongoose')
const passwordPlugin = require('./passwordPlugin')
const { isValidPersonName, isValidPhone, normalizePersonName, normalizePhone } = require('../utils/inputValidation')

const adminSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true, set: normalizePersonName, validate: { validator: isValidPersonName, message: 'Name must contain letters only' } },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 8 },
  phone:    { type: String, trim: true, set: normalizePhone, validate: { validator: value => !value || isValidPhone(value), message: 'Phone must contain 10 to 15 digits' } },
  role:     { type: String, enum: ['admin'], default: 'admin' },
  demoKey:  { type: String, sparse: true, index: true },
}, { timestamps: true })

adminSchema.plugin(passwordPlugin)

module.exports = mongoose.model('Admin', adminSchema)
