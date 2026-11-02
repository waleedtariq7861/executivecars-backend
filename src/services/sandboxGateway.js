// A payment provider that works exactly like a real one from the application's point of view (it accepts a
// method, answers approved or declined, and the application stores the outcome) but moves no money. It is
// the payment provider of this project until a real one is contracted, and every screen says so.
//
// It only accepts published TEST credentials. A real card number, or a real wallet number, is refused before
// anything is read from it, so nobody can hand a real card to a system that does not charge it. Nothing from
// the card or wallet is stored: the caller keeps the brand and the last four digits only.

const TEST_CARDS = {
  '4242424242424242': { outcome: 'approved' },
  '5555555555554444': { outcome: 'approved' },
  '4000000000000002': { outcome: 'declined', code: 'CARD_DECLINED', message: 'The card was declined by the bank.' },
  '4000000000009995': { outcome: 'declined', code: 'INSUFFICIENT_FUNDS', message: 'The card has insufficient funds.' },
}

const TEST_WALLET_NUMBERS = {
  '03000000001': { outcome: 'approved' },
  '03000000002': { outcome: 'declined', code: 'WALLET_DECLINED', message: 'The wallet payment was declined.' },
  '03000000003': { outcome: 'declined', code: 'INSUFFICIENT_FUNDS', message: 'The wallet has insufficient balance.' },
}

const WALLETS = { jazzcash: 'JazzCash', easypaisa: 'Easypaisa' }

const SANDBOX_BANK = Object.freeze({
  bankName: 'Sandbox Bank Ltd',
  accountTitle: 'Executive Cars (Sandbox)',
  iban: 'PK00SBOX0000000000000001',
})

const luhn = digits => {
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9 }
    sum += digit
  }
  return sum % 10 === 0
}

const brandOf = digits => {
  if (/^4/.test(digits)) return 'Visa'
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]|[3-6]|7[01]|720))/.test(digits)) return 'Mastercard'
  if (/^3[47]/.test(digits)) return 'American Express'
  return 'Card'
}

const reject = (code, message, field) => ({ ok: false, validation: true, code, message, field })

/**
 * @returns {{ ok: true, details: object } | { ok: false, validation: true, code: string, message: string, field?: string }
 *   | { ok: false, validation: false, code: string, message: string }}
 */
const chargeCard = (card = {}, now = new Date()) => {
  const digits = String(card.number || '').replace(/[\s-]/g, '')
  if (!/^\d{12,19}$/.test(digits) || !luhn(digits)) return reject('INVALID_CARD_NUMBER', 'Enter a valid card number.', 'cardNumber')

  const month = Number(card.expMonth)
  let year = Number(card.expYear)
  if (year < 100) year += 2000
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) return reject('INVALID_EXPIRY', 'Enter the expiry as MM/YY.', 'expiry')
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return reject('CARD_EXPIRED', 'This card has expired.', 'expiry')

  const cvcLength = brandOf(digits) === 'American Express' ? 4 : 3
  if (!new RegExp(`^\\d{${cvcLength}}$`).test(String(card.cvc || ''))) return reject('INVALID_CVC', `Enter the ${cvcLength}-digit security code.`, 'cvc')
  if (String(card.name || '').trim().length < 2) return reject('INVALID_NAME', 'Enter the name on the card.', 'cardName')

  const known = TEST_CARDS[digits]
  if (!known) {
    return reject('NOT_A_TEST_CARD', 'This is a sandbox: only test cards are accepted, so your card was not charged and was not stored. Use 4242 4242 4242 4242.', 'cardNumber')
  }
  const details = { brand: brandOf(digits), last4: digits.slice(-4) }
  return known.outcome === 'approved' ? { ok: true, details } : { ok: false, validation: false, code: known.code, message: known.message, details }
}

const chargeWallet = (wallet = {}) => {
  const provider = String(wallet.provider || '').toLowerCase()
  if (!WALLETS[provider]) return reject('INVALID_WALLET', 'Choose JazzCash or Easypaisa.', 'walletProvider')
  const number = String(wallet.number || '').replace(/[\s-]/g, '')
  if (!/^03\d{9}$/.test(number)) return reject('INVALID_WALLET_NUMBER', 'Enter the 11-digit mobile number of your wallet, for example 03001234567.', 'walletNumber')

  const known = TEST_WALLET_NUMBERS[number]
  if (!known) return reject('NOT_A_TEST_ACCOUNT', 'This is a sandbox: only test wallet numbers are accepted. Use 03000000001.', 'walletNumber')
  const details = { wallet: provider, maskedNumber: `${number.slice(0, 4)}•••••${number.slice(-2)}` }
  return known.outcome === 'approved' ? { ok: true, details } : { ok: false, validation: false, code: known.code, message: known.message, details }
}

const bankTransfer = (transfer = {}, now = new Date()) => {
  const reference = String(transfer.reference || '').trim()
  if (!/^[A-Za-z0-9-]{6,30}$/.test(reference)) return reject('INVALID_TRANSFER_REFERENCE', 'Enter the transaction ID from your bank (6 to 30 letters or digits).', 'bankReference')
  const date = new Date(transfer.date)
  if (Number.isNaN(date.getTime())) return reject('INVALID_TRANSFER_DATE', 'Enter the date you made the transfer.', 'transferDate')
  if (date.getTime() > now.getTime() + 24 * 60 * 60 * 1000) return reject('INVALID_TRANSFER_DATE', 'The transfer date cannot be in the future.', 'transferDate')
  if (date.getTime() < now.getTime() - 30 * 24 * 60 * 60 * 1000) return reject('INVALID_TRANSFER_DATE', 'The transfer is older than 30 days.', 'transferDate')
  return { ok: true, details: { bankReference: reference, transferDate: date } }
}

const METHODS = [
  { id: 'card', label: 'Debit / credit card', instant: true, testHint: 'Test card 4242 4242 4242 4242, any future expiry, any 3-digit code.' },
  { id: 'wallet', label: 'JazzCash / Easypaisa', instant: true, testHint: 'Test wallet number 03000000001.' },
  { id: 'bank_transfer', label: 'Bank transfer', instant: false, testHint: 'Confirmed by an administrator after you submit the transaction ID.' },
]

module.exports = { chargeCard, chargeWallet, bankTransfer, METHODS, WALLETS, SANDBOX_BANK, TEST_CARDS, TEST_WALLET_NUMBERS }
