const test = require('node:test')
const assert = require('node:assert/strict')
const { bootstrapInput } = require('../scripts/bootstrapAdmin')

const valid = {
  BOOTSTRAP_ADMIN_CONFIRM: 'create-first-admin',
  BOOTSTRAP_ADMIN_NAME: 'Site Administrator',
  BOOTSTRAP_ADMIN_EMAIL: ' Admin@Example.com ',
  BOOTSTRAP_ADMIN_PASSWORD: 'test-password-123',
}

test('admin bootstrap requires deliberate setup and normalizes identity', () => {
  assert.throws(() => bootstrapInput({ ...valid, BOOTSTRAP_ADMIN_CONFIRM: '' }), /BOOTSTRAP_ADMIN_CONFIRM/)
  assert.throws(() => bootstrapInput({ ...valid, BOOTSTRAP_ADMIN_PASSWORD: 'short' }), /BOOTSTRAP_ADMIN_PASSWORD/)
  assert.deepEqual(bootstrapInput(valid), {
    name: 'Site Administrator',
    email: 'admin@example.com',
    password: 'test-password-123',
  })
})
