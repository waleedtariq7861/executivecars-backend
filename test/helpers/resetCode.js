const request = require('supertest')
const email = require('../../src/utils/email')

// Asks for a password-reset code the way a person does and returns what the mailer was handed, so a test can
// use the code without any hook in the application.
const requestResetCode = async (app, address) => {
  const original = email.sendPasswordResetCodeEmail
  let sent
  email.sendPasswordResetCodeEmail = async (to, details) => { sent = { to, ...details } }
  try {
    const response = await request(app).post('/api/auth/forgot-password').send({ email: address })
    await new Promise(resolve => setImmediate(resolve))
    return { response, sent, code: sent?.code }
  } finally {
    email.sendPasswordResetCodeEmail = original
  }
}

module.exports = { requestResetCode }
