const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  isValidCnic,
  isValidPersonName,
  isValidPhone,
  normalizeCnic,
  normalizePhone,
  strictNumber,
} = require('../src/utils/inputValidation')

test('identity validation rejects numbers in names and letters in numeric identities', () => {
  assert.equal(isValidPersonName('Muhammad Ali'), true)
  assert.equal(isValidPersonName('Muhammad 123'), false)
  assert.equal(isValidPersonName('محمد علی'), true)
  assert.equal(normalizePhone('+92 300-1234567'), '+923001234567')
  assert.equal(isValidPhone('+923001234567'), true)
  assert.equal(isValidPhone('+92ABC123'), false)
  assert.equal(normalizeCnic('3520212345671'), '35202-1234567-1')
  assert.equal(isValidCnic('35202-1234567-1'), true)
  assert.equal(isValidCnic('3520A-1234567-1'), false)
})

test('strict numeric parsing rejects exponent notation, signs, and alphabetic values', () => {
  assert.throws(() => strictNumber('Mileage', '1e5', { min: 0, integer: true }))
  assert.throws(() => strictNumber('Mileage', '-1', { min: 0, integer: true }))
  assert.throws(() => strictNumber('Mileage', '12km', { min: 0, integer: true }))
  assert.equal(strictNumber('Mileage', '45000', { min: 0, integer: true }), 45000)
})
