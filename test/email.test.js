const { test } = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const { sendOTPEmail, sendPasswordResetEmail } = require('../src/utils/email')
const { validateRuntimeConfig } = require('../src/config/runtime')

const setEnv = (t, values) => {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('Resend sends OTP and reset email through HTTPS with the configured sender', async t => {
  setEnv(t, {
    EMAIL_DELIVERY_MODE: 'resend',
    RESEND_API_KEY: 're_test_key',
    RESEND_FROM_EMAIL: 'no-reply@account.example.com',
  })
  const originalPost = axios.post
  const requests = []
  axios.post = async (...args) => {
    requests.push(args)
    return { data: { id: 'email-id' } }
  }
  t.after(() => { axios.post = originalPost })

  await sendOTPEmail('member@example.com', '123456')
  await sendPasswordResetEmail('member@example.com', 'https://example.com/reset-password?token=test')

  assert.equal(requests.length, 2)
  for (const [url, payload, options] of requests) {
    assert.equal(url, 'https://api.resend.com/emails')
    assert.equal(payload.from, 'Executive Cars <no-reply@account.example.com>')
    assert.deepEqual(payload.to, ['member@example.com'])
    assert.equal(options.headers.Authorization, 'Bearer re_test_key')
    assert.equal(options.timeout, 10000)
  }
  assert.match(requests[0][1].html, /123456/)
  assert.match(requests[1][1].html, /https:\/\/example.com\/reset-password/)
})

test('Resend configuration and provider errors fail without exposing the provider response', async t => {
  setEnv(t, {
    EMAIL_DELIVERY_MODE: 'resend',
    RESEND_API_KEY: 're_test_key',
    RESEND_FROM_EMAIL: undefined,
  })
  await assert.rejects(sendOTPEmail('member@example.com', '123456'), /RESEND_FROM_EMAIL/)

  process.env.RESEND_FROM_EMAIL = 'no-reply@account.example.com'
  const originalPost = axios.post
  axios.post = async () => {
    const error = new Error('Provider response contains private details')
    error.response = { status: 403 }
    throw error
  }
  t.after(() => { axios.post = originalPost })
  await assert.rejects(sendOTPEmail('member@example.com', '123456'), error => {
    assert.equal(error.message, 'Resend email request failed (HTTP 403)')
    return true
  })
})

test('production Resend mode requires an API key and a sender address', () => {
  const base = {
    APP_MODE: 'production', NODE_ENV: 'production', EMAIL_DELIVERY_MODE: 'resend',
    ENABLE_DEMO_SEED: 'false', PAYMENT_MODE: 'disabled',
    JWT_SECRET: 'this-is-a-long-enough-production-secret', CLIENT_URL: 'https://cars.example',
  }
  assert.throws(() => validateRuntimeConfig(base), /RESEND_API_KEY/)
  assert.throws(() => validateRuntimeConfig({ ...base, RESEND_API_KEY: 're_test_key', RESEND_FROM_EMAIL: 'invalid' }), /RESEND_FROM_EMAIL/)
  assert.deepEqual(validateRuntimeConfig({ ...base, RESEND_API_KEY: 're_test_key', RESEND_FROM_EMAIL: 'no-reply@account.example.com' }), {
    appMode: 'production', demo: false,
  })
})

test('local development email mode remains available without an external request', async t => {
  setEnv(t, { APP_MODE: 'demo', NODE_ENV: 'test', EMAIL_DELIVERY_MODE: 'development' })
  const originalPost = axios.post
  axios.post = async () => { throw new Error('External email request must not be made') }
  t.after(() => { axios.post = originalPost })
  await sendOTPEmail('member@example.com', '123456')
})
