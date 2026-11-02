const OtpChallenge = require('../models/OtpChallenge')

// A booking carries uploaded identity documents. They are accepted only after the code mailed to the customer has
// been confirmed, so the upload (and its storage cost) cannot be triggered by anyone who has not.
const verifiedBookingCode = async (req, res, next) => {
  try {
    const email = String(req.user?.email || '').trim().toLowerCase()
    const verified = await OtpChallenge.exists({ email, verified: true, expiresAt: { $gt: new Date() } })
    if (!verified) return res.status(400).json({ message: 'OTP verification required before submitting' })
    return next()
  } catch (error) {
    return next(error)
  }
}

module.exports = verifiedBookingCode
