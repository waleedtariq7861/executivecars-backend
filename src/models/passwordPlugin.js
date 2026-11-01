const { hashPassword, verifyPassword, needsRehash } = require('../utils/passwordHash')

// One place for credential storage so Member, Admin and Seller cannot drift apart.
module.exports = function passwordPlugin(schema) {
  schema.pre('save', async function hashChangedPassword() {
    if (!this.isModified('password')) return
    this.password = await hashPassword(this.password)
    this.passwordChangedAt = new Date()
  })

  schema.add({ passwordChangedAt: { type: Date } })

  schema.methods.matchPassword = function matchPassword(plain) {
    return verifyPassword(plain, this.password)
  }

  // True when the stored hash is a legacy bcrypt hash or uses weaker Argon2 parameters.
  schema.methods.passwordNeedsRehash = function passwordNeedsRehash() {
    return needsRehash(this.password)
  }
}
