const test = require('node:test')
const assert = require('node:assert/strict')
const { reportFileName, bookingDocumentFileName, contentDisposition } = require('../src/utils/documentNames')

test('a report is named after the car it belongs to', () => {
  assert.equal(reportFileName({ make: 'Toyota', model: 'Corolla', year: 2024 }), 'Toyota-Corolla-2024-inspection-report.pdf')
  assert.equal(
    reportFileName({ make: 'Land Rover', model: 'Range Rover Sport', year: 2021 }),
    'Land-Rover-Range-Rover-Sport-2021-inspection-report.pdf',
  )
})

test('hostile make and model text can never leave the file name', () => {
  const name = reportFileName({ make: 'Hon"da\r\nX-Evil: 1', model: '../City', year: 2022 })
  assert.match(name, /^[A-Za-z0-9-]+\.pdf$/)
})

test('accented letters lose their accent instead of splitting the word', () => {
  assert.equal(
    reportFileName({ make: 'Citroën', model: 'Škoda Ü', year: 2020 }),
    'Citroen-Skoda-U-2020-inspection-report.pdf',
  )
})

test('the header never carries a character outside printable ASCII', () => {
  assert.match(contentDisposition('Škoda 車.pdf'), /^inline; filename="[\x20-\x7e]*"$/)
})

test('a car without make, model or year still gets a plain name', () => {
  assert.equal(reportFileName({}), 'inspection-report.pdf')
  assert.equal(reportFileName({ make: 'Honda' }), 'Honda-inspection-report.pdf')
})

test('booking documents are named by kind and keep a safe stored extension', () => {
  assert.equal(bookingDocumentFileName('cnic', { extension: '.pdf' }), 'cnic-document.pdf')
  assert.equal(bookingDocumentFileName('registration', { extension: '.jpg' }), 'registration-document.jpg')
  assert.equal(bookingDocumentFileName('cnic', { extension: '.p/df' }), 'cnic-document')
  assert.equal(bookingDocumentFileName('cnic', {}), 'cnic-document')
})

test('the header asks the browser to show the file inline under that name', () => {
  assert.equal(contentDisposition('a.pdf'), 'inline; filename="a.pdf"')
  const header = contentDisposition('a"b\r\n.pdf')
  assert.doesNotMatch(header, /[\r\n]/)
  assert.equal(header.split('"').length, 3, 'exactly one quoted value')
})
