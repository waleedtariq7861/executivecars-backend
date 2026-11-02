// Customers who have not confirmed their email address can use the site but not bid or activate
// membership. Administrators are not customers and are not affected.
const verifiedEmail = (req, res, next) => {
  if (req.accountModel === 'member' && !req.user.isEmailVerified()) {
    return res.status(403).json({ message: 'Verify your email address to continue.', code: 'EMAIL_NOT_VERIFIED' })
  }
  next()
}

module.exports = verifiedEmail
