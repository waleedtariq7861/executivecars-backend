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

const memberSchema = new mongoose.Schema({
  name:                 { type: String, required: true, trim: true, set: normalizePersonName, validate: { validator: isValidPersonName, message: 'Name must contain letters only' } },
  email:                { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:             { type: String, required: true, minlength: 8 },
  phone:                { type: String, trim: true, set: normalizePhone, validate: { validator: value => !value || isValidPhone(value), message: 'Phone must contain 10 to 15 digits' } },
  cnic:                 { type: String, trim: true, set: normalizeCnic, validate: { validator: value => !value || isValidCnic(value), message: 'CNIC must use XXXXX-XXXXXXX-X format' } },
  address:              { type: String, trim: true },
  city:                 { type: String, trim: true },
  role:                 { type: String, enum: ['user'], default: 'user' },
  sellerApproved:       { type: Boolean, default: false },
  sellerBookingId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  stripeCustomerId:     { type: String },
  subscriptionStatus:   { type: String, enum: ['active', 'inactive', 'expired'], default: 'inactive' },
  subscriptionPlan:     { type: String, enum: ['annual_auction_membership'], default: undefined },
  subscriptionStartedAt:{ type: Date },
  subscriptionExpiry:   { type: Date },
  subscriptionUpdatedAt:{ type: Date },
  membershipSource:     { type: String, enum: ['stripe', 'demo'], default: undefined },
  checkoutSessionId:    { type: String },
  savedCars:            [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  demoKey:              { type: String, sparse: true, index: true },
}, { timestamps: true })

memberSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

memberSchema.methods.matchPassword = function (plain) {
  return bcrypt.compare(plain, this.password)
}

memberSchema.methods.hasActiveSubscription = function () {
  return this.subscriptionStatus === 'active'
    && this.subscriptionExpiry instanceof Date
    && this.subscriptionExpiry.getTime() > Date.now()
}

module.exports = mongoose.model('Member', memberSchema)
