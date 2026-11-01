const { hashPassword, verifyPassword } = require('../utils/passwordHash')

// One place for credential storage so Member and Admin cannot drift apart.
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
}
