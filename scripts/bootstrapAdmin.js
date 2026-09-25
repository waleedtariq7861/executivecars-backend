require('dotenv').config()

const mongoose = require('mongoose')
const connectDB = require('../src/config/db')
const Admin = require('../src/models/Admin')
const { isValidPersonName, normalizePersonName } = require('../src/utils/inputValidation')

const bootstrapInput = (env = process.env) => {
  const name = normalizePersonName(env.BOOTSTRAP_ADMIN_NAME)
  const email = String(env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase()
  const password = String(env.BOOTSTRAP_ADMIN_PASSWORD || '')
  if (env.BOOTSTRAP_ADMIN_CONFIRM !== 'create-first-admin') {
    throw new Error('Set BOOTSTRAP_ADMIN_CONFIRM=create-first-admin for the one-time setup')
  }
  if (!isValidPersonName(name)) throw new Error('BOOTSTRAP_ADMIN_NAME must be a valid full name')
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address')
  if (password.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters')
  return { name, email, password }
}

const bootstrapAdmin = async (env = process.env) => {
  const account = bootstrapInput(env)
  if (mongoose.connection.readyState === 0) await connectDB()
  if (await Admin.exists({})) throw new Error('An admin account already exists; bootstrap refused')
  await Admin.create({ ...account, role: 'admin' })
  return account.email
}

if (require.main === module) {
  bootstrapAdmin()
    .then(email => console.log(`First administrator created: ${email}`))
    .catch(error => { console.error(`Admin bootstrap failed: ${error.message}`); process.exitCode = 1 })
    .finally(() => mongoose.disconnect())
}

module.exports = { bootstrapInput, bootstrapAdmin }
