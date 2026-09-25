const test = require('node:test')
const assert = require('node:assert/strict')
const { validateRuntimeConfig } = require('../src/config/runtime')

test('free production configuration refuses temporary upload storage', () => {
  const config = {
    APP_MODE: 'production', NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(32), CLIENT_URL: 'https://app.example.com',
    REQUIRE_CLOUDINARY: 'true',
  }
  assert.throws(() => validateRuntimeConfig(config), /Cloudinary/)
  assert.doesNotThrow(() => validateRuntimeConfig({
    ...config,
    CLOUDINARY_CLOUD_NAME: 'cloud', CLOUDINARY_API_KEY: 'key', CLOUDINARY_API_SECRET: 'secret',
  }))
})
