const crypto = require('crypto')
const Booking = require('../models/Booking')
const OtpChallenge = require('../models/OtpChallenge')
const { sendOTPEmail, sendBookingConfirmationEmail } = require('../utils/email')
const { uploadedFileUrl } = require('../config/cloudinary')
const { handleControllerError } = require('../utils/http')
const {
  isValidCnic,
  isValidPersonName,
  isValidPhone,
  normalizeCnic,
  normalizePersonName,
  normalizePhone,
  strictNumber,
} = require('../utils/inputValidation')

const normalizeEmail = (email = '') => email.trim().toLowerCase()
const digestOTP = (email, otp) => crypto
  .createHmac('sha256', process.env.JWT_SECRET)
  .update(`${email}:${otp}`)
  .digest('hex')

const authenticatedEmail = (req, res) => {
  const email = normalizeEmail(req.user?.email)
  const requestedEmail = normalizeEmail(req.body.email)
  if (requestedEmail && requestedEmail !== email) {
    res.status(403).json({ message: 'Booking email must match the signed-in member account' })
    return null
  }
  return email
}

// Send OTP to email
const sendOTP = async (req, res) => {
  try {
    const email = authenticatedEmail(req, res)
    if (!email) return
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'A valid email is required' })

    const existing = await OtpChallenge.findOne({ email }).select('updatedAt')
    if (existing && Date.now() - existing.updatedAt.getTime() < 60 * 1000) {
      return res.status(429).json({ message: 'Please wait one minute before requesting another OTP' })
    }

    const otp = crypto.randomInt(100000, 999999).toString()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

    await OtpChallenge.findOneAndUpdate(
      { email },
      { otpDigest: digestOTP(email, otp), expiresAt, verified: false, attempts: 0 },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    )

    if (process.env.NODE_ENV !== 'production' && process.env.EMAIL_DELIVERY_MODE === 'development') {
      return res.json({
        message: 'Development email mode is active. Use the OTP shown on screen.',
        delivery: 'development',
        devOtp: otp,
      })
    }

    try {
      await sendOTPEmail(email, otp)
      return res.json({ message: 'OTP sent to your email', delivery: 'email' })
    } catch (emailError) {
      if (process.env.NODE_ENV === 'production') {
        await OtpChallenge.deleteOne({ email })
        return res.status(502).json({ message: 'Verification email could not be sent. Please try again later.' })
      }

      console.warn(`OTP email unavailable for ${email}: ${emailError.message}`)
      return res.json({
        message: 'Email delivery is unavailable locally. Use the development OTP shown on screen.',
        delivery: 'development',
        devOtp: otp,
      })
    }
  } catch (err) {
    handleControllerError(res, err, 'Could not send verification code')
  }
}

// Verify OTP
const verifyOTP = async (req, res) => {
  try {
    const email = authenticatedEmail(req, res)
    if (!email) return
    const { otp } = req.body
    if (!email || !/^\d{6}$/.test(String(otp || ''))) {
      return res.status(400).json({ message: 'Enter a valid 6-digit OTP' })
    }

    const record = await OtpChallenge.findOne({ email, verified: false })
    if (!record) return res.status(400).json({ message: 'No pending OTP for this email' })
    if (record.expiresAt < new Date()) {
      await record.deleteOne()
      return res.status(400).json({ message: 'OTP has expired' })
    }
    if (record.attempts >= 5) return res.status(429).json({ message: 'Too many incorrect attempts. Request a new OTP.' })

    const suppliedDigest = digestOTP(email, String(otp))
    const isCorrect = crypto.timingSafeEqual(Buffer.from(record.otpDigest), Buffer.from(suppliedDigest))
    if (!isCorrect) {
      record.attempts += 1
      await record.save()
      return res.status(400).json({ message: 'Incorrect OTP' })
    }

    record.verified = true
    await record.save()

    res.json({ message: 'OTP verified successfully', verified: true })
  } catch (err) {
    handleControllerError(res, err, 'Could not verify code')
  }
}

// Submit full booking (after OTP verified, with file uploads)
const submitBooking = async (req, res) => {
  try {
    const name = normalizePersonName(req.body.name)
    const phone = normalizePhone(req.body.phone)
    const cnic = normalizeCnic(req.body.cnic)
    const carMake = String(req.body.carMake || '').trim()
    const carModel = String(req.body.carModel || '').trim()
    const date = String(req.body.date || '').trim()
    const time = String(req.body.time || '').trim()
    const branch = String(req.body.branch || '').trim()
    const email = authenticatedEmail(req, res)
    if (!email) return

    if (!name || !email || !phone || !carMake || !carModel || !date || !branch) {
      return res.status(400).json({ message: 'Required fields missing' })
    }
    const fieldErrors = {}
    if (!isValidPersonName(name)) fieldErrors.name = 'Name must contain letters only.'
    if (!isValidPhone(phone)) fieldErrors.phone = 'Phone must contain 10 to 15 digits.'
    if (cnic && !isValidCnic(cnic)) fieldErrors.cnic = 'CNIC must contain exactly 13 digits.'

    let carYear
    let mileage
    let engineCC
    try {
      carYear = strictNumber('Vehicle year', req.body.carYear, { min: 1900, max: new Date().getFullYear() + 1, integer: true })
    } catch (error) {
      fieldErrors.carYear = error.message
    }
    try {
      mileage = strictNumber('Mileage', req.body.mileage, { min: 0, max: 1000000, integer: true })
    } catch (error) {
      fieldErrors.mileage = error.message
    }
    try {
      engineCC = strictNumber('Engine capacity', req.body.engineCC, { min: 1, max: 10000, integer: true })
    } catch (error) {
      fieldErrors.engineCC = error.message
    }
    if (Object.keys(fieldErrors).length) {
      return res.status(400).json({ message: 'Please correct the invalid booking fields.', errors: fieldErrors })
    }

    const bookingDate = new Date(`${date}T00:00:00`)
    if (Number.isNaN(bookingDate.getTime()) || bookingDate < new Date(new Date().setHours(0, 0, 0, 0))) {
      return res.status(400).json({ message: 'Inspection date must be today or later' })
    }

    const duplicate = await Booking.exists({
      memberId: req.user._id,
      carMake,
      carModel,
      date,
      time,
      status: { $in: ['pending', 'approved', 'confirmed'] },
    })
    if (duplicate) {
      return res.status(409).json({ message: 'You already have an active inspection booking for this vehicle and slot.' })
    }

    // Consume the verified challenge atomically to prevent duplicate submissions.
    const otpRecord = await OtpChallenge.findOneAndDelete({ email, verified: true, expiresAt: { $gt: new Date() } })
    if (!otpRecord) return res.status(400).json({ message: 'OTP verification required before submitting' })

    const cnicImageUrl = uploadedFileUrl(req, req.files?.cnicImage?.[0])
    const regDocUrl = uploadedFileUrl(req, req.files?.regDoc?.[0])

    const booking = await Booking.create({
      memberId: req.user._id,
      name,
      email,
      phone,
      cnic: cnic || '',
      carMake,
      carModel,
      carYear: String(carYear),
      mileage: String(mileage),
      engineCC: String(engineCC),
      cnicImageUrl,
      regDocUrl,
      date,
      time,
      branch,
      status: 'pending',
    })

    sendBookingConfirmationEmail(email, name, date, branch).catch(() => {})

    res.status(201).json({ message: 'Booking submitted successfully', bookingId: booking._id })
  } catch (err) {
    handleControllerError(res, err, 'Could not submit booking')
  }
}

module.exports = { sendOTP, verifyOTP, submitBooking }
